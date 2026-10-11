"""Dry Run Python tracer.

Runs inside Pyodide (browser Web Worker, or Node for tests). Executes the
user's code with sys.settrace and streams normalized trace events (see
docs/trace-schema.md) to the host through a `post(json_text)` callback.

Event semantics (Python adapter):
  call       frame entered, arguments bound, before the first body line
  line       the line is ABOUT to execute (sys.settrace semantics); state is pre-line
  return     frame about to pop; `returnValue` set unless unwinding from an exception;
             generator frames report `yielded: true` when suspending at a yield
  exception  exception raised in / propagating through the innermost frame
  stdout     emitted lazily right before the next event when output was written
  complete   normal termination (terminal)
  limit      a resource limit stopped execution (terminal)
An uncaught exception produces a terminal `exception` event with `uncaught: true`.
"""

import ast
import builtins
import collections
import dis
import json
import sys
import textwrap
import time
import types

USER_FILE = "<dryrun>"
HARNESS_FILE = "<dryrun-harness>"
FRAGMENT_FN = "__dryrun_fragment__"
CO_GENERATOR = 0x20
_YIELD_OPS = set(dis.opmap[n] for n in ("YIELD_VALUE", "INSTRUMENTED_YIELD_VALUE") if n in dis.opmap)
_MAX_SAFE_INT = 2 ** 53
_MAX_STDOUT = 200_000


class DryRunAbort(BaseException):
    """Raised inside user code to stop execution when a limit is hit.

    Derives from BaseException so `except Exception:` in user code does not
    swallow it. A bare `except:` can; that case is documented and the
    controlling thread's watchdog still terminates the worker.
    """

    def __init__(self, kind, message, limit=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.limit = limit


# ---------------------------------------------------------------------------
# LeetCode-style helper classes, provided only when the user does not define them.
# Defined in a separate pseudo-file so they are never traced as user code.
_HARNESS_SRC = '''
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
'''


def _harness_namespace():
    ns = {"__name__": "dryrun_harness"}
    exec(compile(_HARNESS_SRC, HARNESS_FILE, "exec"), ns)
    return ns


class _Stdout:
    encoding = "utf-8"

    def __init__(self, tracer):
        self._t = tracer

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError("write() argument must be str, not %s" % type(s).__name__)
        self._t.on_write(s)
        return len(s)

    def writelines(self, lines):
        for s in lines:
            self.write(s)

    def flush(self):
        pass

    def isatty(self):
        return False


class _Stdin:
    def __init__(self, text):
        self._lines = text.splitlines(True)

    def readline(self, *_):
        return self._lines.pop(0) if self._lines else ""

    def read(self, *_):
        out = "".join(self._lines)
        self._lines = []
        return out

    def __iter__(self):
        while self._lines:
            yield self._lines.pop(0)

    def isatty(self):
        return False


# ---------------------------------------------------------------------------
class _Snapshot:
    """Serializes the object graph reachable from a set of roots (BFS)."""

    def __init__(self, tracer):
        self.t = tracer
        self.lim = tracer.limits
        self.objs = {}
        self.queue = collections.deque()
        self.seen = set()
        self.count = 0
        self.items = 0
        self.item_budget = self.lim["maxObjects"] * 20

    def val(self, x, depth):
        tp = type(x)
        if x is None:
            return {"t": "none"}
        if tp is bool:
            return {"t": "bool", "v": x}
        if tp is int or (isinstance(x, int) and not isinstance(x, bool) and tp.__module__ in ("builtins", "enum")):
            if -_MAX_SAFE_INT < x < _MAX_SAFE_INT:
                return {"t": "int", "v": int(x)}
            return {"t": "int", "v": repr(int(x)), "big": True}
        if tp is float:
            if x != x or x in (float("inf"), float("-inf")):
                return {"t": "float", "v": repr(x)}
            return {"t": "float", "v": x}
        if tp is str:
            m = self.lim["maxString"]
            if len(x) > m:
                return {"t": "str", "v": x[:m], "len": len(x)}
            return {"t": "str", "v": x}
        sid = self.t.sid(x)
        if sid not in self.seen:
            self.seen.add(sid)
            self.queue.append((x, sid, depth))
        return {"t": "ref", "id": sid}

    def drain(self):
        while self.queue:
            x, sid, depth = self.queue.popleft()
            self.objs[sid] = self.encode(x, sid, depth)
        return self.objs

    def _items(self, seq, length, depth):
        cap = self.lim["maxItems"]
        out = []
        reason = None
        for i, e in enumerate(seq):
            if i >= cap:
                reason = "items"
                break
            if self.items >= self.item_budget:
                reason = "budget"
                break
            self.items += 1
            out.append(e)
        return out, reason

    def encode(self, x, sid, depth):
        tname = type(x).__name__
        if depth > self.lim["maxDepth"] or self.count >= self.lim["maxObjects"]:
            d = {"id": sid, "kind": "elided", "typeName": tname,
                 "reason": "depth" if depth > self.lim["maxDepth"] else "budget"}
            try:
                if isinstance(x, (list, tuple, dict, set, frozenset, collections.deque)):
                    d["length"] = len(x)
            except Exception:
                pass
            return d
        self.count += 1
        nd = depth + 1
        if isinstance(x, (list, tuple, set, frozenset, collections.deque)) and not hasattr(x, "_fields"):
            if isinstance(x, collections.deque):
                kind = "deque"
            elif isinstance(x, tuple):
                kind = "tuple"
            elif isinstance(x, (set, frozenset)):
                kind = "set"
            else:
                kind = "list"
            n = len(x)
            raw, reason = self._items(x, n, depth)
            d = {"id": sid, "kind": kind, "typeName": tname, "items": [self.val(e, nd) for e in raw], "length": n}
            if reason:
                d["truncated"] = {"reason": reason, "shown": len(raw), "total": n}
            if kind == "deque" and x.maxlen is not None:
                d["maxlen"] = x.maxlen
            return d
        if isinstance(x, tuple):  # namedtuple → object with fields
            attrs = [[f, self.val(getattr(x, f), nd)] for f in x._fields]
            return {"id": sid, "kind": "object", "typeName": tname, "attrs": attrs}
        if isinstance(x, dict):
            n = len(x)
            raw, reason = self._items(list(x.items()), n, depth)
            d = {"id": sid, "kind": "dict", "typeName": tname,
                 "entries": [[self.val(k, nd), self.val(v, nd)] for k, v in raw], "length": n}
            if reason:
                d["truncated"] = {"reason": reason, "shown": len(raw), "total": n}
            if isinstance(x, collections.defaultdict):
                f = x.default_factory
                d["defaultFactory"] = getattr(f, "__name__", repr(f)) if f is not None else "None"
            return d
        if isinstance(x, (types.FunctionType, types.BuiltinFunctionType, types.MethodType, types.LambdaType)):
            return {"id": sid, "kind": "function", "typeName": tname, "repr": getattr(x, "__qualname__", tname)}
        if isinstance(x, type):
            return {"id": sid, "kind": "class", "typeName": "type", "repr": x.__name__}
        if isinstance(x, (types.ModuleType, BaseException, range, types.GeneratorType)) or tname in ("method-wrapper", "builtin_function_or_method"):
            return {"id": sid, "kind": "other", "typeName": tname, "repr": _safe_repr(x)}
        attrs = None
        try:
            dct = object.__getattribute__(x, "__dict__")
            attrs = [(k, v) for k, v in dct.items() if not (k.startswith("__") and k.endswith("__"))]
        except Exception:
            slots = []
            for klass in type(x).__mro__:
                s = klass.__dict__.get("__slots__", ())
                slots.extend([s] if isinstance(s, str) else list(s))
            if slots:
                attrs = []
                for s in slots:
                    try:
                        attrs.append((s, object.__getattribute__(x, s)))
                    except Exception:
                        pass
        if attrs is not None and type(x).__module__ not in ("builtins",):
            n = len(attrs)
            raw, reason = self._items(attrs, n, depth)
            d = {"id": sid, "kind": "object", "typeName": tname, "attrs": [[k, self.val(v, nd)] for k, v in raw]}
            if reason:
                d["truncated"] = {"reason": reason, "shown": len(raw), "total": n}
            return d
        return {"id": sid, "kind": "other", "typeName": tname, "repr": _safe_repr(x)}


def _safe_repr(x, limit=200):
    try:
        r = object.__repr__(x) if type(x).__module__ == "__main__" else repr(x)
    except Exception:
        r = "<%s object>" % type(x).__name__
    return r if len(r) <= limit else r[: limit - 1] + "…"


# ---------------------------------------------------------------------------
class Tracer:
    def __init__(self, limits, post):
        self.limits = limits
        self.post = post
        self.batch = []
        self.last_flush = time.monotonic()
        self.n_events = 0
        self.obj_ids = {}  # id(obj) -> (obj, sid); strong refs keep ids stable for the run
        self.next_obj = 1
        self.sent = {}  # sid -> json of last sent encoding
        self.frame_ids = {}  # id(frame) -> fid (frames are alive while registered)
        self.next_frame = 1
        self.out_pending = []
        self.out_total = 0
        self.stopped = False
        self.globals = None
        self.hidden = {}  # name -> object that was preloaded by the harness
        self.mode = "script"
        self.deadline = time.monotonic() + limits["timeoutMs"] / 1000.0
        self.last_line = 0
        self.abort = None

    # -- identity ----------------------------------------------------------
    def sid(self, obj):
        k = id(obj)
        e = self.obj_ids.get(k)
        if e is not None and e[0] is obj:
            return e[1]
        s = "o%d" % self.next_obj
        self.next_obj += 1
        self.obj_ids[k] = (obj, s)
        return s

    def fid(self, frame, create=True):
        k = id(frame)
        f = self.frame_ids.get(k)
        if f is None and create:
            f = "f%d" % self.next_frame
            self.next_frame += 1
            self.frame_ids[k] = f
        return f

    # -- stdout ------------------------------------------------------------
    def on_write(self, s):
        if self.out_total + len(s) > _MAX_STDOUT:
            s = s[: max(0, _MAX_STDOUT - self.out_total)]
            if not s:
                return
        self.out_total += len(s)
        self.out_pending.append(s)

    # -- snapshots ---------------------------------------------------------
    def _visible_globals(self, g):
        out = []
        for k, v in list(g.items()):
            if k.startswith("__") or k.startswith(FRAGMENT_FN):
                continue
            if isinstance(v, types.ModuleType):
                continue
            h = self.hidden.get(k, _MISSING)
            if h is not _MISSING and h is v:
                continue
            out.append((k, v))
        return out

    def _frame_locals(self, f):
        code = f.f_code
        if code.co_name == "<module>":
            return self._visible_globals(f.f_globals)
        try:
            items = list(f.f_locals.items())
        except Exception:
            items = []
        return [(k, v) for k, v in items if not k.startswith(".") and not k.startswith("__dryrun")]

    @staticmethod
    def _arg_names(code):
        n = code.co_argcount + code.co_kwonlyargcount
        if code.co_flags & 0x04:
            n += 1
        if code.co_flags & 0x08:
            n += 1
        return list(code.co_varnames[:n])

    def _user_frames(self, frame):
        out = []
        f = frame
        while f is not None:
            if f.f_code.co_filename == USER_FILE:
                out.append(f)
            f = f.f_back
        out.reverse()
        return out

    def build_event(self, etype, frame, line, extra=None, stack_frames=None):
        snap = _Snapshot(self)
        frames = self._user_frames(frame) if stack_frames is None else stack_frames
        stack = []
        for f in frames:
            code = f.f_code
            name = code.co_name
            if name == FRAGMENT_FN:
                name = "<fragment>"
            entry = {
                "id": self.fid(f),
                "name": name,
                "line": (f.f_lineno if f is not frame else line) or code.co_firstlineno or 1,
                "args": self._arg_names(code) if name != "<module>" else [],
                "locals": [[k, snap.val(v, 0)] for k, v in self._frame_locals(f)],
            }
            if code.co_flags & CO_GENERATOR:
                entry["isGenerator"] = True
            stack.append(entry)
        ev = {"type": etype, "line": line, "stack": stack}
        if (self.mode != "script" or stack_frames == []) and self.globals is not None:
            ev["globals"] = [[k, snap.val(v, 0)] for k, v in self._visible_globals(self.globals)]
        if extra:
            for k, v in extra.items():
                if k in ("returnValue", "result"):
                    ev[k] = snap.val(v, 0)
                else:
                    ev[k] = v
        objs = snap.drain()
        delta = {}
        for sid, d in objs.items():
            s = json.dumps(d, separators=(",", ":"))
            if self.sent.get(sid) != s:
                self.sent[sid] = s
                delta[sid] = d
        ev["heap"] = delta
        return ev

    def _emit_raw(self, ev):
        self.batch.append(json.dumps(ev, separators=(",", ":")))
        self.n_events += 1
        now = time.monotonic()
        if len(self.batch) >= 200 or now - self.last_flush > 0.05:
            self.flush()

    def flush(self):
        if self.batch:
            self.post("[" + ",".join(self.batch) + "]")
            self.batch = []
        self.last_flush = time.monotonic()

    def emit(self, etype, frame, line, extra=None):
        """Emit an event, enforcing limits. May raise DryRunAbort."""
        if self.stopped:
            return
        if self.out_pending:
            text = "".join(self.out_pending)
            self.out_pending = []
            pev = self.build_event("stdout", frame, self.last_line or line)
            pev["out"] = text
            self._check_budget(frame, line)
            self._emit_raw(pev)
        self._check_budget(frame, line)
        self._emit_raw(self.build_event(etype, frame, line, extra))

    def _check_budget(self, frame, line):
        lim = None
        if self.n_events >= self.limits["maxEvents"]:
            lim = ("events", "Stopped after recording %d events (event budget)." % self.limits["maxEvents"], self.limits["maxEvents"])
        elif time.monotonic() > self.deadline:
            lim = ("time", "Stopped after %.1f s (time limit)." % (self.limits["timeoutMs"] / 1000.0), self.limits["timeoutMs"])
        if lim:
            self._stop_with_limit(frame, line, *lim)

    def _stop_with_limit(self, frame, line, kind, message, limit):
        sys.settrace(None)
        self.stopped = True
        ev = self.build_event("limit", frame, line, {"limit": {"kind": kind, "message": message, "limit": limit}})
        self._emit_raw(ev)
        self.flush()
        self.abort = DryRunAbort(kind, message, limit)
        raise self.abort

    # -- sys.settrace callbacks -------------------------------------------
    def global_trace(self, frame, event, arg):
        if self.stopped or frame.f_code.co_filename != USER_FILE:
            return None
        if event == "call":
            depth = len(self._user_frames(frame))
            if depth > self.limits["maxStackDepth"]:
                self._stop_with_limit(frame, frame.f_lineno, "stack",
                                      "Stopped: call stack exceeded %d frames (stack limit)." % self.limits["maxStackDepth"],
                                      self.limits["maxStackDepth"])
            line = frame.f_lineno or frame.f_code.co_firstlineno or 1
            self.last_line = line
            self.emit("call", frame, line)
            return self.local_trace
        return None

    def local_trace(self, frame, event, arg):
        if self.stopped:
            return None
        line = frame.f_lineno
        if event == "line":
            self.emit("line", frame, line)
            self.last_line = line
        elif event == "return":
            extra = {}
            gen = bool(frame.f_code.co_flags & CO_GENERATOR)
            yielded = False
            if gen:
                try:
                    yielded = frame.f_code.co_code[frame.f_lasti] in _YIELD_OPS
                except Exception:
                    yielded = False
            if getattr(self, "_unwinding", None) is frame:
                extra["unwind"] = True
                self._unwinding = None
            else:
                extra["returnValue"] = arg
                if yielded:
                    extra["yielded"] = True
            self.emit("return", frame, line, extra)
            if not yielded:
                self.frame_ids.pop(id(frame), None)
        elif event == "exception":
            etype, evalue, tb = arg
            if isinstance(evalue, DryRunAbort):
                return None
            self.emit("exception", frame, line, {"exception": {
                "type": etype.__name__, "message": _exc_message(evalue), "line": line}})
            # If the next event for this frame is `return`, it is unwinding.
            self._unwinding = frame
        if event == "line" and getattr(self, "_unwinding", None) is frame:
            self._unwinding = None  # handled inside this frame
        return self.local_trace

    # -- harness -----------------------------------------------------------
    def terminal(self, etype, extra):
        if self.stopped:
            return
        self.stopped = True
        if self.out_pending:
            text = "".join(self.out_pending)
            self.out_pending = []
            ev = self.build_event("stdout", None, self.last_line, stack_frames=[])
            ev["out"] = text
            self._emit_raw(ev)
        self._emit_raw(self.build_event(etype, None, self.last_line, extra, stack_frames=[]))
        self.flush()

    def start(self):
        self.deadline = time.monotonic() + self.limits["timeoutMs"] / 1000.0
        sys.settrace(self.global_trace)

    def stop(self):
        sys.settrace(None)


_MISSING = object()


def _exc_message(e):
    try:
        return str(e)
    except Exception:
        return "<unprintable %s>" % type(e).__name__


def _user_traceback(tb):
    out = []
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == USER_FILE:
            name = tb.tb_frame.f_code.co_name
            out.append({"name": "<fragment>" if name == FRAGMENT_FN else name, "line": tb.tb_lineno})
        tb = tb.tb_next
    return out


def _to_jsonable(x, depth=0, seen=None):
    """Plain-JSON view of a result for comparison with expected output."""
    if seen is None:
        seen = set()
    if depth > 200:
        return "…"
    if x is None or isinstance(x, (bool, str)):
        return x
    if isinstance(x, int):
        return x
    if isinstance(x, float):
        return x if x == x and x not in (float("inf"), float("-inf")) else repr(x)
    if id(x) in seen:
        return "<cycle>"
    if isinstance(x, (list, tuple, collections.deque)):
        seen.add(id(x))
        r = [_to_jsonable(e, depth + 1, seen) for e in x]
        seen.discard(id(x))
        return r
    if isinstance(x, (set, frozenset)):
        try:
            return sorted(_to_jsonable(e, depth + 1, seen) for e in x)
        except TypeError:
            return [_to_jsonable(e, depth + 1, seen) for e in x]
    if isinstance(x, dict):
        return {str(k): _to_jsonable(v, depth + 1, seen) for k, v in x.items()}
    if hasattr(x, "next") and hasattr(x, "val") and not hasattr(x, "left"):
        out = []
        node = x
        visited = set()
        while node is not None and id(node) not in visited and len(out) < 10000:
            visited.add(id(node))
            out.append(_to_jsonable(node.val, depth + 1, seen))
            node = node.next
        return out
    if hasattr(x, "left") and hasattr(x, "right") and hasattr(x, "val"):
        out = []
        q = collections.deque([x])
        visited = set()
        while q and len(out) < 10000:
            n = q.popleft()
            if n is None:
                out.append(None)
                continue
            if id(n) in visited:
                out.append("<cycle>")
                continue
            visited.add(id(n))
            out.append(_to_jsonable(n.val, depth + 1, seen))
            q.append(n.left)
            q.append(n.right)
        while out and out[-1] is None:
            out.pop()
        return out
    return _safe_repr(x)


def _build_linked_list(values, node_cls):
    if values is None:
        return None
    if not isinstance(values, list):
        raise TypeError("linked-list argument must be a JSON array")
    head = None
    for v in reversed(values):
        n = node_cls(v)
        n.next = head
        head = n
    return head


def _build_tree(values, node_cls):
    if values is None or len(values) == 0 or values[0] is None:
        return None
    if not isinstance(values, list):
        raise TypeError("binary-tree argument must be a JSON array in level order")
    it = iter(values)
    root = node_cls(next(it))
    q = collections.deque([root])
    while q:
        node = q.popleft()
        try:
            lv = next(it)
        except StopIteration:
            break
        if lv is not None:
            node.left = node_cls(lv)
            q.append(node.left)
        try:
            rv = next(it)
        except StopIteration:
            break
        if rv is not None:
            node.right = node_cls(rv)
            q.append(node.right)
    return root


def _convert_special(v, g):
    """Fragment-mode initial values: {"$tuple": [...]}, {"$set": [...]}, {"$deque": [...]},
    {"$linkedList": [...]}, {"$tree": [...]} construct the matching structure."""
    if isinstance(v, list):
        return [_convert_special(e, g) for e in v]
    if isinstance(v, dict):
        if len(v) == 1:
            (k, inner), = v.items()
            if k == "$tuple":
                return tuple(_convert_special(e, g) for e in inner)
            if k == "$set":
                return set(_convert_special(e, g) if not isinstance(e, list) else tuple(e) for e in inner)
            if k == "$deque":
                return collections.deque(_convert_special(e, g) for e in inner)
            if k == "$linkedList":
                return _build_linked_list(inner, g["ListNode"])
            if k == "$tree":
                return _build_tree(inner, g["TreeNode"])
        return {k: _convert_special(e, g) for k, e in v.items()}
    return v


def _syntax_diag(e):
    return {"severity": "error", "kind": type(e).__name__, "message": e.msg or str(e),
            "line": e.lineno or 1, "column": max(0, (e.offset or 1) - 1),
            "endLine": getattr(e, "end_lineno", None) or e.lineno or 1,
            "endColumn": max(0, (getattr(e, "end_offset", None) or (e.offset or 1)) - 1)}


def run(request_json, post):
    """Entry point called by the host. Returns the ExecutionSummary as JSON text."""
    req = json.loads(request_json)
    limits = req["limits"]
    mode = req["mode"]
    tracer = Tracer(limits, post)
    tracer.mode = mode
    summary = {"status": "completed", "diagnostics": [], "durationMs": 0}

    g = {"__name__": "__main__", "__builtins__": builtins}
    harness = _harness_namespace()
    preload = {"ListNode": harness["ListNode"], "TreeNode": harness["TreeNode"]}
    try:
        import typing
        for name in ("List", "Optional", "Dict", "Set", "Tuple", "Deque", "DefaultDict", "Any", "Union"):
            preload[name] = getattr(typing, name)
    except Exception:
        pass
    g.update(preload)
    tracer.hidden = dict(preload)
    tracer.globals = g

    source = req["source"]
    old_out, old_err, old_in = sys.stdout, sys.stderr, sys.stdin
    sys.stdout = _Stdout(tracer)
    sys.stderr = sys.stdout
    sys.stdin = _Stdin(req.get("stdin") or "")
    old_limit = sys.getrecursionlimit()
    t0 = time.monotonic()
    try:
        if mode == "fragment":
            frag = req["fragment"]
            try:
                init = json.loads(frag.get("initialState") or "{}")
            except ValueError as e:
                summary["status"] = "syntax-error"
                summary["diagnostics"].append({"severity": "error", "kind": "InitialStateError",
                                               "message": "Initial state is not valid JSON: %s" % e, "line": 1})
                return json.dumps(summary)
            if not isinstance(init, dict):
                summary["status"] = "syntax-error"
                summary["diagnostics"].append({"severity": "error", "kind": "InitialStateError",
                                               "message": "Initial state must be a JSON object of variable names", "line": 1})
                return json.dumps(summary)
            for name in init:
                if not name.isidentifier():
                    summary["status"] = "syntax-error"
                    summary["diagnostics"].append({"severity": "error", "kind": "InitialStateError",
                                                   "message": "%r is not a valid Python variable name" % name, "line": 1})
                    return json.dumps(summary)
            setup = frag.get("setup") or ""
            start = int(frag.get("startLine") or 1)
            text = textwrap.dedent(source)
            padded = "\n" * (start - 1) + text
            try:
                if setup.strip():
                    exec(compile(setup, "<dryrun-setup>", "exec"), g)
                    tracer.hidden.update({k: v for k, v in g.items()})
                tree = ast.parse(padded, USER_FILE)
                fn = ast.FunctionDef(
                    name=FRAGMENT_FN,
                    args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=n) for n in init],
                                       vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
                    body=tree.body or [ast.Pass()], decorator_list=[], returns=None, type_params=[])
                fn.lineno = start
                fn.col_offset = 0
                last = fn.body[-1]
                fn.end_lineno = max(start, getattr(last, "end_lineno", None) or start)
                fn.end_col_offset = getattr(last, "end_col_offset", None) or 0
                mod = ast.Module(body=[fn], type_ignores=[])
                ast.fix_missing_locations(mod)
                code = compile(mod, USER_FILE, "exec")
            except SyntaxError as e:
                summary["status"] = "syntax-error"
                summary["diagnostics"].append(_syntax_diag(e))
                return json.dumps(summary)
            except ValueError as e:
                raise _HarnessError("Could not build the fragment harness: %s" % e)
            exec(code, g)
            target = g.pop(FRAGMENT_FN)
            values = {k: _convert_special(v, g) for k, v in init.items()}
            summary["harnessDescription"] = (
                "Fragment executed as the body of a function whose parameters are the initial-state "
                "variables (%s). Setup code ran untraced first." % (", ".join(init) or "none"))
            t0 = time.monotonic()
            tracer.start()
            try:
                result = target(**values)
            finally:
                tracer.stop()
            tracer.terminal("complete", {"result": result})
            summary["resultJson"] = json.dumps(_to_jsonable(result))
        else:
            try:
                code = compile(source, USER_FILE, "exec")
            except SyntaxError as e:
                summary["status"] = "syntax-error"
                summary["diagnostics"].append(_syntax_diag(e))
                return json.dumps(summary)
            if mode == "script":
                t0 = time.monotonic()
                tracer.start()
                try:
                    exec(code, g)
                finally:
                    tracer.stop()
                tracer.terminal("complete", {})
            else:
                exec(code, g)  # definitions run untraced in function mode
                entry = req.get("entry") or ""
                parts = entry.split(".")
                if len(parts) == 2:
                    cls = g.get(parts[0])
                    if cls is None:
                        raise _HarnessError("Class %r is not defined" % parts[0])
                    inst = cls()
                    fn = getattr(inst, parts[1], None)
                else:
                    fn = g.get(entry)
                if not callable(fn):
                    raise _HarnessError("Entry point %r was not found or is not callable" % entry)
                args = []
                convs = req.get("argConversions") or []
                for i, a in enumerate(req.get("args") or []):
                    try:
                        v = json.loads(a) if a.strip() else None
                    except ValueError as e:
                        raise _HarnessError("Argument %d is not valid JSON: %s" % (i + 1, e))
                    conv = convs[i] if i < len(convs) else "raw"
                    if conv == "linked-list":
                        v = _build_linked_list(v, g["ListNode"])
                    elif conv == "binary-tree":
                        v = _build_tree(v, g["TreeNode"])
                    args.append(v)
                t0 = time.monotonic()
                tracer.start()
                try:
                    result = fn(*args)
                finally:
                    tracer.stop()
                tracer.terminal("complete", {"result": result})
                summary["resultJson"] = json.dumps(_to_jsonable(result))
    except DryRunAbort as e:
        tracer.stop()
        summary["status"] = "limit"
        summary["limit"] = {"kind": e.kind, "message": e.message}
    except _HarnessError as e:
        tracer.stop()
        summary["status"] = "internal-error"
        summary["diagnostics"].append({"severity": "error", "kind": "HarnessError", "message": str(e), "line": 1})
    except RecursionError as e:
        tracer.stop()
        tb = _user_traceback(e.__traceback__)
        summary["status"] = "exception"
        tracer.terminal("exception", {"exception": {"type": "RecursionError", "message": _exc_message(e),
                                                    "line": tb[-1]["line"] if tb else None, "uncaught": True,
                                                    "traceback": tb[-20:]}})
    except Exception as e:
        tracer.stop()
        if tracer.abort is not None:
            # user code replaced our abort with another exception (e.g. in a finally block)
            summary["status"] = "limit"
            summary["limit"] = {"kind": tracer.abort.kind, "message": tracer.abort.message}
        else:
            tb = _user_traceback(e.__traceback__)
            summary["status"] = "exception"
            line = tb[-1]["line"] if tb else None
            tracer.terminal("exception", {"exception": {"type": type(e).__name__, "message": _exc_message(e),
                                                        "line": line, "uncaught": True, "traceback": tb}})
            if not tb and mode == "function":
                summary["diagnostics"].append({"severity": "error", "kind": type(e).__name__,
                                               "message": "Failed before entering your code: %s" % _exc_message(e),
                                               "line": 1})
    finally:
        sys.settrace(None)
        tracer.flush()
        sys.stdout, sys.stderr, sys.stdin = old_out, old_err, old_in
        sys.setrecursionlimit(old_limit)
        summary["durationMs"] = int((time.monotonic() - t0) * 1000)
        summary["events"] = tracer.n_events
    return json.dumps(summary)


class _HarnessError(Exception):
    pass


# ---------------------------------------------------------------------------
# Static analysis (no user code is executed).

def _names_in(node):
    return sorted({n.id for n in ast.walk(node) if isinstance(n, ast.Name)})


def analyze(source):
    out = {"ok": True, "diagnostics": [], "functions": [], "classes": [], "accesses": [],
           "heapBases": [], "entryCandidates": [], "scriptLike": True, "sizeNames": []}
    try:
        tree = ast.parse(source, USER_FILE)
    except SyntaxError as e:
        out["ok"] = False
        out["diagnostics"].append(_syntax_diag(e))
        return json.dumps(out)

    def fn_info(node, cls=None):
        params = []
        a = node.args
        all_args = a.posonlyargs + a.args
        for i, p in enumerate(all_args):
            if cls is not None and i == 0 and p.arg in ("self", "cls"):
                continue
            params.append({"name": p.arg, "annotation": ast.unparse(p.annotation) if p.annotation else None})
        info = {"name": node.name, "qualname": "%s.%s" % (cls, node.name) if cls else node.name,
                "params": params, "line": node.lineno, "endLine": node.end_lineno or node.lineno}
        if cls:
            info["className"] = cls
        if node.returns is not None:
            info["returnAnnotation"] = ast.unparse(node.returns)
        return info

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out["functions"].append(fn_info(node))
        elif isinstance(node, ast.ClassDef):
            methods = []
            attrs = set()
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append(sub.name)
                    out["functions"].append(fn_info(sub, node.name))
            for sub in ast.walk(node):
                if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == "self" \
                        and isinstance(sub.ctx, ast.Store):
                    attrs.add(sub.attr)
            out["classes"].append({"name": node.name, "line": node.lineno, "endLine": node.end_lineno or node.lineno,
                                   "methods": methods, "attrs": sorted(attrs)})

    # nested functions for range lookup (not entry candidates)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not any(f["line"] == node.lineno and f["name"] == node.name for f in out["functions"]):
                info = fn_info(node)
                info["qualname"] = "<nested>." + node.name
                out["functions"].append(info)

    # subscript chains
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    aug_targets = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.AugAssign):
            aug_targets.add(node.target)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Subscript):
            continue
        p = parents.get(node)
        if isinstance(p, ast.Subscript) and p.value is node:
            continue  # not maximal
        chain = []
        cur = node
        while isinstance(cur, ast.Subscript):
            chain.append(cur.slice)
            cur = cur.value
        chain.reverse()
        try:
            base = ast.unparse(cur)
        except Exception:
            continue
        indices = []
        names = []
        for s in chain:
            if isinstance(s, ast.Slice):
                lo = ast.unparse(s.lower) if s.lower else ""
                hi = ast.unparse(s.upper) if s.upper else ""
                indices.append(lo + ":" + hi)
            else:
                indices.append(ast.unparse(s))
            names.append(_names_in(s))
        write = isinstance(node.ctx, (ast.Store, ast.Del)) or node in aug_targets
        out["accesses"].append({"line": node.lineno, "base": base, "indices": indices,
                                "indexNames": names, "write": write, "kind": "subscript"})
        if write and node in aug_targets:
            out["accesses"].append({"line": node.lineno, "base": base, "indices": indices,
                                    "indexNames": names, "write": False, "kind": "subscript"})

    # Loop-structure evidence that a variable indexes a sequence.
    def _len_arg(node):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "len" and node.args:
            return node.args[0]
        return None

    def _loop_access(line, base_node, name):
        try:
            base = ast.unparse(base_node)
        except Exception:
            return
        out["accesses"].append({"line": line, "base": base, "indices": [name], "indexNames": [[name]],
                                "write": False, "kind": "loop"})

    # Counters: names stepped with += / -= or used as for-loop targets.
    counters = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and isinstance(node.op, (ast.Add, ast.Sub)):
            counters.add(node.target.id)
        elif isinstance(node, (ast.For, ast.comprehension)):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    counters.add(sub.id)

    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.comprehension)):
            it = node.iter
            line = getattr(node, "lineno", None) or getattr(it, "lineno", 1)
            tgt = node.target
            if isinstance(it, ast.Call) and isinstance(it.func, ast.Name):
                if it.func.id == "enumerate" and it.args and isinstance(tgt, ast.Tuple) and tgt.elts \
                        and isinstance(tgt.elts[0], ast.Name):
                    _loop_access(line, it.args[0], tgt.elts[0].id)
                elif it.func.id == "range" and isinstance(tgt, ast.Name):
                    for a in it.args:
                        for sub in ast.walk(a):
                            arg = _len_arg(sub)
                            if arg is not None:
                                _loop_access(line, arg, tgt.id)
        elif isinstance(node, ast.Compare):
            operands = [node.left] + list(node.comparators)
            names = [o.id for o in operands if isinstance(o, ast.Name) and o.id in counters]
            for o in operands:
                for sub in ast.walk(o):
                    arg = _len_arg(sub)
                    if arg is not None:
                        for n in names:
                            _loop_access(node.lineno, arg, n)

    # Variables holding sizes (`n = len(xs)`, `rows, cols = len(g), len(g[0])`): not pointers on their own.
    size_names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                vals = node.value.elts if isinstance(node.value, ast.Tuple) else [node.value]
                tgts = tgt.elts if isinstance(tgt, ast.Tuple) else [tgt]
                if len(vals) != len(tgts):
                    continue
                for t_, v_ in zip(tgts, vals):
                    if isinstance(t_, ast.Name) and _len_arg(v_) is not None:
                        size_names.add(t_.id)
    out["sizeNames"] = sorted(size_names)

    heap_fns = {"heappush", "heappop", "heapify", "heapreplace", "heappushpop", "nsmallest", "nlargest"}
    heap_bases = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and node.args:
            f = node.func
            fname = f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
            if fname in heap_fns and fname not in ("nsmallest", "nlargest"):
                try:
                    heap_bases.add(ast.unparse(node.args[0]))
                except Exception:
                    pass
    out["heapBases"] = sorted(heap_bases)

    cands = []
    sol = [c for c in out["classes"] if c["name"] == "Solution"]
    for c in sol + [c for c in out["classes"] if c["name"] != "Solution"]:
        for f in out["functions"]:
            if f.get("className") == c["name"] and not f["name"].startswith("_"):
                cands.append(f["qualname"])
        if c["name"] == "Solution" and cands:
            break
    if not sol:
        cands = [f["qualname"] for f in out["functions"]
                 if "className" not in f and not f["qualname"].startswith("<nested>") and not f["name"].startswith("_")]
    out["entryCandidates"] = cands
    top_level_stmts = [n for n in tree.body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                                                  ast.Import, ast.ImportFrom))
                       and not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))]
    out["scriptLike"] = not cands or (bool(top_level_stmts) and not sol)
    return json.dumps(out)
