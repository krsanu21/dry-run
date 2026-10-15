import { useState } from "react";
import type { FunctionInfo } from "../analysis/types";
import { toJson } from "../trace/literal";
import type { ArgConversion } from "../trace/schema";
import { isTerminal, type Trace } from "../trace/store";
import { formatValue } from "../trace/values";
import {
  addCasesFromText,
  addTest,
  autoConversion,
  duplicateTest,
  effectiveConversion,
  examplesNotAdded,
  removeTest,
  run,
  runAllTests,
  runTarget,
  type RunTarget,
  selectTest,
  setConversion,
  setTarget,
  updateTest,
} from "./actions";
import { activeTest, store, type TestCase, type TestResult, useApp, WHOLE_FILE } from "./store";

type DockTab = "cases" | "output";

export function InputDock(): React.JSX.Element {
  const [tab, setTab] = useState<DockTab>("cases");
  const status = useApp((s) => s.run.status);
  const outcome = useApp((s) => s.run.outcome);
  return (
    <div className="dock">
      <div className="dock-tabs" role="tablist" aria-label="Test cases and output">
        {(["cases", "output"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`dock-tab${tab === t ? " is-on" : ""}`} onClick={() => setTab(t)} data-testid={`dock-${t}`}>
            {t === "cases" ? "Test cases" : "Output"}
            {t === "output" && outcome && status === "done" && <span className={`status-dot sd-${outcome.summary.status}`} aria-label={outcome.summary.status} />}
          </button>
        ))}
      </div>
      <div className="dock-body" role="tabpanel">
        {tab === "cases" ? <CasesTab /> : <OutputTab />}
      </div>
    </div>
  );
}

const sig = (fn: FunctionInfo | undefined, entry: string): string => `${entry.split(".").pop()}(${fn?.params.map((p) => p.name).join(", ") ?? ""})`;

function CasesTab(): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const analysis = useApp((s) => s.analysis);
  const target = runTarget(ws, analysis);
  return (
    <div className="cases-tab">
      <TargetLine target={target} />
      {target.kind === "function" && (
        <>
          <PasteBox />
          <ExamplesBanner fn={target.fn} />
          <CasesTable fn={target.fn} />
        </>
      )}
      {target.kind === "file" &&
        (analysis?.usesInput || ws.stdin ? (
          <div className="field-col">
            <label htmlFor="stdin">Program input — what input() reads, one line per call</label>
            <textarea id="stdin" className="mono" rows={4} value={ws.stdin} onChange={(e) => store.updateWs({ stdin: e.target.value })} spellCheck={false} data-testid="stdin" />
          </div>
        ) : (
          <p className="dim small">Nothing to fill in: the file sets up its own data. Press Run.</p>
        ))}
    </div>
  );
}

/** One sentence saying what Run does, and the only place to change it. */
function TargetLine({ target }: { target: RunTarget }): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const analysis = useApp((s) => s.analysis);
  const [open, setOpen] = useState(false);
  const choices = analysis?.entryCandidates ?? [];
  const pick = (t: string): void => {
    setTarget(t);
    setOpen(false);
  };
  return (
    <div className="target-line" data-testid="target-line">
      <span className="target-text">
        {target.kind === "unknown" && <span className="dim">Reading your code…</span>}
        {target.kind === "function" && (
          <>
            Runs <code>{sig(target.fn, target.entry)}</code> on your test cases
          </>
        )}
        {target.kind === "file" && (
          <>
            Runs the <strong>whole file</strong>, top to bottom
            {target.alt && (
              <>
                {" "}
                · or{" "}
                <button type="button" className="link-btn" onClick={() => pick(target.alt as string)} data-testid="target-alt">
                  test {target.alt.split(".").pop()} with your own inputs
                </button>
              </>
            )}
          </>
        )}
      </span>
      {(choices.length > 0 || ws.target) && (
        <span className="target-menu">
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="target-change">
            change ▾
          </button>
          {open && (
            <div className="menu" role="menu">
              {choices.map((c) => (
                <button key={c} type="button" role="menuitemradio" aria-checked={target.kind === "function" && target.entry === c} onClick={() => pick(c)}>
                  {sig(analysis?.functions.find((f) => f.qualname === c), c)}
                </button>
              ))}
              <button type="button" role="menuitemradio" aria-checked={target.kind === "file"} onClick={() => pick(WHOLE_FILE)} data-testid="target-file">
                Whole file, top to bottom
              </button>
              {ws.target && (
                <button type="button" role="menuitem" className="dim" onClick={() => pick("")}>
                  Decide from the code
                </button>
              )}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

function PasteBox(): React.JSX.Element {
  const [text, setText] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const add = (): void => {
    if (!text.trim()) return;
    const before = store.get().ws.tests.length;
    const p = addCasesFromText(text);
    setProblems(p);
    if (store.get().ws.tests.length >= before && !p.length) setText("");
  };
  return (
    <div className="paste-box">
      <div className="paste-row">
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Paste an example, e.g. nums = [2,7], target = 9"
          aria-label="Paste a LeetCode example"
          spellCheck={false}
          className="mono"
          data-testid="paste-example"
        />
        <button type="button" className="btn" onClick={add} disabled={!text.trim()} data-testid="paste-add">
          Add
        </button>
      </div>
      {problems.length > 0 && (
        <ul className="paste-problems" data-testid="paste-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExamplesBanner({ fn }: { fn: FunctionInfo | undefined }): React.JSX.Element | null {
  const ws = useApp((s) => s.ws);
  const [dismissed, setDismissed] = useState("");
  const found = examplesNotAdded(ws, fn);
  const key = `${ws.id}:${found.length}`;
  if (!found.length || dismissed === key) return null;
  return (
    <div className="examples-banner" data-testid="examples-banner">
      Found {found.length} example{found.length > 1 ? "s" : ""} in your code.
      <button type="button" className="btn small" onClick={() => found.forEach((c) => addTest(c.args, c.expected))} data-testid="examples-add">
        Add {found.length > 1 ? "them" : "it"}
      </button>
      <button type="button" className="link-btn dim" onClick={() => setDismissed(key)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

const CONV_LABEL: Record<ArgConversion, string> = { auto: "auto", raw: "as written", "linked-list": "linked list", "binary-tree": "tree" };

function CasesTable({ fn }: { fn: FunctionInfo | undefined }): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const results = useApp((s) => s.results);
  const traced = useApp((s) => (s.run.trace ? s.run.testId : null));
  const running = useApp((s) => (s.run.status === "running" || s.run.status === "starting" ? s.run.testId : null));
  const [menu, setMenu] = useState<string | null>(null);
  const params = fn?.params ?? [];
  const select = (t: TestCase): void => {
    if (t.id !== ws.activeTestId) selectTest(t.id);
  };
  return (
    <div className="cases">
      <table className="cases-table" data-testid="cases">
        <thead>
          <tr>
            <th className="c-num">#</th>
            {params.map((p, i) => {
              const eff = effectiveConversion(ws, fn, i);
              const chosen = ws.conversions[i] ?? "auto";
              return (
                <th key={p.name}>
                  <span className="mono">{p.name}</span>
                  <select
                    className={`conv-badge${eff === "raw" ? " is-plain" : ""}`}
                    value={chosen}
                    onChange={(e) => setConversion(i, e.target.value as ArgConversion)}
                    aria-label={`How ${p.name} is built`}
                    title="How this argument is built from the value you type"
                    data-testid={`conv-${i}`}
                  >
                    <option value="auto">{chosen === "auto" && eff !== "raw" ? CONV_LABEL[eff] : `auto (${CONV_LABEL[autoConversion(fn, i, ws.language).conv]})`}</option>
                    <option value="raw">as written</option>
                    <option value="linked-list">linked list</option>
                    <option value="binary-tree">tree (level order)</option>
                  </select>
                </th>
              );
            })}
            <th>expected</th>
            <th className="c-result-h">result</th>
            <th className="c-act" />
          </tr>
        </thead>
        <tbody>
          {ws.tests.map((t, row) => (
            <tr key={t.id} className={`${t.id === ws.activeTestId ? "is-active" : ""}${t.id === traced ? " is-traced" : ""}`} onClick={() => select(t)} data-testid={`case-${row}`}>
              <td className="c-num">{row + 1}</td>
              {params.map((p, i) => (
                <td key={p.name}>
                  <textarea
                    rows={1}
                    className="cell-input mono"
                    value={t.args[i] ?? ""}
                    spellCheck={false}
                    aria-label={`Case ${row + 1}: ${p.name}`}
                    onFocus={() => select(t)}
                    onChange={(e) => {
                      const args = [...t.args];
                      while (args.length <= i) args.push("");
                      args[i] = e.target.value;
                      updateTest(t.id, { args });
                    }}
                    data-testid={`arg-${row}-${i}`}
                  />
                </td>
              ))}
              <td>
                <textarea
                  rows={1}
                  className="cell-input mono"
                  value={t.expected}
                  placeholder="—"
                  spellCheck={false}
                  aria-label={`Case ${row + 1}: expected result`}
                  onFocus={() => select(t)}
                  onChange={(e) => updateTest(t.id, { expected: e.target.value })}
                  data-testid={`expected-${row}`}
                />
              </td>
              <td className="c-result" data-testid={`result-${row}`}>
                {running === t.id ? <span className="dim">running…</span> : <ResultCell r={results[t.id]} expected={t.expected} source={ws.source} />}
              </td>
              <td className="c-act">
                <button
                  type="button"
                  className="row-menu-btn"
                  aria-label={`Actions for case ${row + 1}`}
                  aria-expanded={menu === t.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === t.id ? null : t.id);
                  }}
                  data-testid={`case-menu-${row}`}
                >
                  ⋯
                </button>
                {menu === t.id && (
                  <div className="menu row-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        duplicateTest(t.id);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => {
                        setMenu(null);
                        removeTest(t.id);
                      }}
                      data-testid={`case-delete-${row}`}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cases-foot">
        <button type="button" className="link-btn" onClick={() => addTest(params.map(() => ""))} data-testid="add-test">
          + add case
        </button>
        {ws.tests.length > 1 && (
          <button type="button" className="btn small" onClick={() => void runAllTests()} data-testid="run-all">
            Run all
          </button>
        )}
      </div>
    </div>
  );
}

function ResultCell({ r, expected, source }: { r: TestResult | undefined; expected: string; source: string }): React.JSX.Element {
  const lang = useApp((s) => s.ws.language);
  if (!r) return <span className="dim">—</span>;
  const last = r.trace.last;
  const outdated = r.sourceAtRun !== source;
  const wrap = (cls: string, text: string, title: string): React.JSX.Element => (
    <span className={`${cls}${outdated ? " is-outdated" : ""}`} title={outdated ? `${title} (the code changed since this run)` : title}>
      {text}
    </span>
  );
  if (!last || !isTerminal(last)) return <span className="dim">…</span>;
  if (last.type === "exception") return wrap("bad", `⚠ ${last.exception?.type ?? "error"}`, `${last.exception?.type}: ${last.exception?.message}`);
  if (last.type === "limit") return wrap("warn", "■ stopped", last.limit?.message ?? "stopped");
  const got = last.result ? formatValue(last.result, last.heap, lang, { maxLength: 40, maxDepth: 3 }) : "—";
  if (!expected.trim()) return wrap("", got, got);
  const ok = resultMatchFromJson(r.outcome?.summary.resultJson, r.outcome?.summary.status ?? "", expected);
  return wrap(ok ? "ok" : "bad", `${ok ? "✓" : "✗"} ${got}`, ok ? "matches expected" : `expected ${expected}, got ${got}`);
}

function deepEq(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

export function resultMatchFromJson(rj: string | undefined, status: string, expected: string): boolean {
  if (rj === undefined || status !== "completed") return false;
  try {
    return deepEq(JSON.parse(rj), JSON.parse(toJson(expected) ?? expected));
  } catch {
    return rj.trim() === expected.trim();
  }
}

function OutputTab(): React.JSX.Element {
  const trace = useApp((s) => s.run.trace);
  const version = useApp((s) => s.run.version);
  const cursor = useApp((s) => s.cursor);
  const outcome = useApp((s) => s.run.outcome);
  const status = useApp((s) => s.run.status);
  const isCall = useApp((s) => s.run.request?.mode === "function");
  const test = useApp(activeTest);
  const lang = useApp((s) => s.ws.language);
  const prefs = useApp((s) => s.prefs.limits);
  void version;
  if (!trace) return <div className="side-empty">Output appears after a run.</div>;
  const out = trace.stdoutAt(Math.min(cursor, trace.length - 1));
  const last = trace.last;
  const summary = outcome?.summary;
  const r = summary?.resultJson;
  const match = isCall && test.expected.trim() && summary ? resultMatchFromJson(r, summary.status, test.expected) : null;
  return (
    <div className="output-tab" data-testid="output">
      <div className={`run-status rs-${summary?.status ?? status}`} data-testid="run-status">
        {status !== "done" ? (
          <span>● {status === "starting" ? "starting runtime…" : `recording… ${trace.length} steps`}</span>
        ) : summary ? (
          <StatusLine trace={trace} />
        ) : null}
      </div>
      {summary?.diagnostics.map((d, i) => (
        <div key={i} className={`diag diag-${d.severity}`}>
          {d.kind} (line {d.line}): {d.message}
        </div>
      ))}
      {isCall && last && isTerminal(last) && last.type === "complete" && (
        <div className="result-block">
          <div>
            <span className="dim">Returned</span> <code data-testid="result-value">{last.result ? formatValue(last.result, last.heap, lang, { maxLength: 400, maxDepth: 6 }) : "—"}</code>
          </div>
          {test.expected.trim() && (
            <div>
              <span className="dim">Expected</span> <code>{test.expected}</code>{" "}
              {match ? (
                <span className="ok" data-testid="match">
                  ✓ match
                </span>
              ) : (
                <span className="bad" data-testid="match">
                  ✕ differs
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {last?.type === "limit" && (
        <div className="limit-block" role="alert">
          <strong>Execution stopped:</strong> {last.limit?.message}
          <div className="dim small">
            Limits: {prefs.maxEvents} steps · {(prefs.timeoutMs / 1000).toFixed(0)} s · stack {prefs.maxStackDepth}. Change them in Settings (⚙). The {trace.length - 1} recorded steps before the stop are kept.
          </div>
        </div>
      )}
      <div className="stdout-head">
        <span>Printed output up to this step</span>
        <span className="dim small">{out.length} chars</span>
      </div>
      <pre className="stdout mono" data-testid="stdout">
        {out || <span className="dim">(nothing printed yet)</span>}
      </pre>
    </div>
  );
}

function StatusLine({ trace }: { trace: Trace }): React.JSX.Element {
  const last = trace.last;
  const s = trace.summary;
  if (!last) return <span>Nothing was recorded{s ? ` (${s.status})` : ""}.</span>;
  if (last.type === "complete") return <span className="ok">✓ Completed · steps 0–{trace.length - 1} · {s?.durationMs ?? 0} ms</span>;
  if (last.type === "exception")
    return (
      <span className="bad">
        ✕ {last.exception?.type}: {last.exception?.message} {last.exception?.line ? `(line ${last.exception.line})` : ""}
      </span>
    );
  if (last.type === "limit") return <span className="warn">■ Stopped: {last.limit?.message}</span>;
  return <span>{s?.status}</span>;
}
