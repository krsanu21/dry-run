import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  WidgetType,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import type { Diagnostic, Language } from "../trace/schema";

// ---------------------------------------------------------------------------
// Breakpoints

class BreakpointMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-bp-dot";
    el.setAttribute("aria-label", "breakpoint");
    return el;
  }
}
const bpMarker = new BreakpointMarker();
const setBreakpointsEffect = StateEffect.define<number[]>();

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBreakpointsEffect)) {
        const doc = tr.state.doc;
        const ranges = e.value.filter((l) => l >= 1 && l <= doc.lines).map((l) => bpMarker.range(doc.line(l).from));
        next = RangeSet.of(ranges, true);
      }
    }
    return next;
  },
});

function breakpointLines(state: EditorState): number[] {
  const out: number[] = [];
  state.field(breakpointField).between(0, state.doc.length, (from) => {
    out.push(state.doc.lineAt(from).number);
  });
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Trace line highlighting

export interface TraceMark {
  line: number;
  /** what the highlighted line means at the selected event */
  kind: "next" | "call" | "return" | "exception" | "done";
  /** the line that just executed (previous event), if different */
  prevLine?: number;
}

const setTraceMark = StateEffect.define<TraceMark | null>();

class ArrowMarker extends GutterMarker {
  constructor(private readonly kind: TraceMark["kind"]) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof ArrowMarker && other.kind === this.kind;
  }
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = `cm-trace-arrow cm-trace-arrow-${this.kind}`;
    el.textContent = this.kind === "exception" ? "!" : this.kind === "return" ? "↩" : "▶";
    return el;
  }
}

const traceField = StateField.define<{ deco: DecorationSet; gutter: RangeSet<GutterMarker> }>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    let { deco, gutter: g } = value;
    deco = deco.map(tr.changes);
    g = g.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setTraceMark)) continue;
      const m = e.value;
      const doc = tr.state.doc;
      if (!m || m.line < 1 || m.line > doc.lines) {
        deco = Decoration.none;
        g = RangeSet.empty;
        continue;
      }
      const ranges = [];
      if (m.prevLine && m.prevLine !== m.line && m.prevLine >= 1 && m.prevLine <= doc.lines) {
        const pl = doc.line(m.prevLine);
        ranges.push({ from: pl.from, deco: Decoration.line({ class: "cm-trace-prev" }) });
      }
      const l = doc.line(m.line);
      ranges.push({ from: l.from, deco: Decoration.line({ class: `cm-trace-line cm-trace-${m.kind}` }) });
      ranges.sort((a, b) => a.from - b.from);
      deco = Decoration.set(ranges.map((r) => r.deco.range(r.from)));
      g = RangeSet.of([new ArrowMarker(m.kind).range(l.from)]);
    }
    return { deco, gutter: g };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// ---------------------------------------------------------------------------
// Error lens: errors are written out in full beneath the offending line, so
// they can be read without hovering and never cover the code.

export interface EditorDiagnostic extends Diagnostic {
  /** short explanation of what this kind of error usually means */
  hint?: string;
  /** where the error came from, e.g. "raised at step 41 (last step)" */
  note?: string;
}

class ErrorLensWidget extends WidgetType {
  constructor(private readonly d: EditorDiagnostic) {
    super();
  }
  override eq(o: WidgetType): boolean {
    return (
      o instanceof ErrorLensWidget &&
      o.d.kind === this.d.kind &&
      o.d.message === this.d.message &&
      o.d.hint === this.d.hint &&
      o.d.note === this.d.note &&
      o.d.severity === this.d.severity &&
      o.d.column === this.d.column
    );
  }
  override toDOM(): HTMLElement {
    const d = this.d;
    const el = document.createElement("div");
    el.className = `cm-error-lens cm-error-lens-${d.severity}`;
    el.setAttribute("role", d.severity === "error" ? "alert" : "status");
    el.dataset.testid = "error-lens";
    const head = document.createElement("div");
    head.className = "cm-error-lens-head";
    const icon = document.createElement("span");
    icon.className = "cm-error-lens-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = d.severity === "error" ? "✕" : d.severity === "warning" ? "!" : "i";
    const kind = document.createElement("span");
    kind.className = "cm-error-lens-kind";
    kind.textContent = d.kind;
    const msg = document.createElement("span");
    msg.className = "cm-error-lens-msg";
    msg.textContent = d.message;
    const where = document.createElement("span");
    where.className = "cm-error-lens-where";
    where.textContent = `line ${d.line}${d.column !== undefined ? `:${d.column + 1}` : ""}${d.note ? ` · ${d.note}` : ""}`;
    head.append(icon, kind, msg, where);
    el.append(head);
    if (d.hint) {
      const hint = document.createElement("div");
      hint.className = "cm-error-lens-hint";
      hint.textContent = d.hint;
      el.append(hint);
    }
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const setErrorLens = StateEffect.define<EditorDiagnostic[]>();

const errorLensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrorLens)) continue;
      const doc = tr.state.doc;
      const seen = new Set<number>();
      const ranges = e.value
        .filter((d) => d.line >= 1 && d.line <= doc.lines && d.severity !== "info")
        // one panel per line, errors first, at most four in total
        .sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "error" ? -1 : 1))
        .filter((d) => (seen.has(d.line) ? false : (seen.add(d.line), true)))
        .slice(0, 4)
        .map((d) => Decoration.widget({ widget: new ErrorLensWidget(d), block: true, side: 1 }).range(doc.line(d.line).to))
        .sort((a, b) => a.from - b.from);
      deco = Decoration.set(ranges);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Squiggle range for a diagnostic: the reported span, else the line without its indentation; never zero-width. */
function diagnosticRange(doc: EditorState["doc"], d: Diagnostic): { from: number; to: number } {
  const line = doc.line(d.line);
  const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
  let from = d.column !== undefined ? Math.min(line.to, line.from + d.column) : line.from + indent;
  let to = line.to;
  if (d.endLine && d.endLine >= d.line && d.endLine <= doc.lines && (d.endLine !== d.line || (d.endColumn ?? 0) > (d.column ?? 0)))
    to = Math.min(doc.line(d.endLine).to, doc.line(d.endLine).from + (d.endColumn ?? 0));
  else if (d.column !== undefined && /Syntax|Indentation|Tab/.test(d.kind)) {
    // a syntax error points at one position: mark the token there
    const m = /^(\w+|\S)/.exec(line.text.slice(from - line.from));
    to = from + (m ? m[0].length : 0);
  }
  if (to <= from) {
    if (from < line.to) to = from + 1;
    else if (from > line.from) from = Math.max(line.from + indent, from - 1);
  }
  return { from, to: Math.max(from, to) };
}

// ---------------------------------------------------------------------------
// Highlighting via CSS variables so one style serves both themes

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--syn-fn)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.className, t.typeName, t.definition(t.className)], color: "var(--syn-type)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-self)" },
  { tag: [t.propertyName], color: "var(--syn-prop)" },
  { tag: [t.operator, t.punctuation], color: "var(--syn-punct)" },
]);

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--code-size)", backgroundColor: "var(--editor-bg)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)", paddingBottom: "40vh" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--text-faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-dim)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  // diagnostics, themed to match the app instead of CodeMirror's light defaults
  ".cm-tooltip": { backgroundColor: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--line-2)", borderRadius: "6px", boxShadow: "var(--shadow)" },
  ".cm-tooltip-lint": { padding: "0", maxWidth: "min(560px, 90vw)" },
  ".cm-diagnostic": { padding: "6px 10px", borderLeft: "3px solid var(--text-faint)", fontFamily: "var(--mono)", fontSize: "12px", whiteSpace: "pre-wrap" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--err)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warn)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--focus)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--err)", textDecorationSkipInk: "none", textUnderlineOffset: "3px", backgroundColor: "var(--err-bg)" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--focus)", textUnderlineOffset: "3px" },
  ".cm-lint-marker": { width: "0.9em", height: "0.9em" },
});

// ---------------------------------------------------------------------------

export interface EditorProps {
  value: string;
  language: Language;
  readOnly: boolean;
  breakpoints: number[];
  traceMark: TraceMark | null;
  diagnostics: EditorDiagnostic[];
  /** move the cursor to and scroll to this line; `n` changes on every request */
  reveal?: { line: number; n: number } | null;
  onChange(value: string): void;
  onToggleBreakpoint(line: number): void;
  onBreakpointsMoved(lines: number[]): void;
  onSelectionLines?(range: { from: number; to: number } | null): void;
  onRequestEdit?(): void;
}

export function CodeEditor(props: EditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const langComp = useRef(new Compartment());
  const roComp = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const langExt = (l: Language): Extension => (l === "python" ? python() : javascript());
    const toggleAt = (v: EditorView, pos: number): boolean => {
      propsRef.current.onToggleBreakpoint(v.state.doc.lineAt(pos).number);
      return true;
    };
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        breakpointField,
        traceField,
        errorLensField,
        gutter({
          class: "cm-bp-gutter",
          markers: (v) => v.state.field(breakpointField),
          initialSpacer: () => bpMarker,
          domEventHandlers: { mousedown: (v, line) => toggleAt(v, line.from) },
        }),
        gutter({ class: "cm-trace-gutter", markers: (v) => v.state.field(traceField).gutter }),
        lineNumbers({ domEventHandlers: { mousedown: (v, line) => toggleAt(v, line.from) } }),
        lintGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        indentUnit.of("    "),
        syntaxHighlighting(highlight),
        baseTheme,
        langComp.current.of(langExt(props.language)),
        roComp.current.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
        keymap.of([
          { key: "F9", run: (v) => toggleAt(v, v.state.selection.main.head) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ "aria-label": "Source code editor" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            propsRef.current.onChange(u.state.doc.toString());
            const lines = breakpointLines(u.state);
            const prev = propsRef.current.breakpoints;
            if (lines.length !== prev.length || lines.some((l, i) => l !== prev[i])) propsRef.current.onBreakpointsMoved(lines.sort((a, b) => a - b));
          }
          if (u.selectionSet && propsRef.current.onSelectionLines) {
            const sel = u.state.selection.main;
            if (sel.empty) propsRef.current.onSelectionLines(null);
            else {
              const from = u.state.doc.lineAt(sel.from).number;
              const toLine = u.state.doc.lineAt(sel.to);
              const to = sel.to === toLine.from && toLine.number > from ? toLine.number - 1 : toLine.number;
              propsRef.current.onSelectionLines({ from, to });
            }
          }
        }),
        EditorView.domEventHandlers({
          mousedown: (_e, v) => {
            if (v.state.readOnly) propsRef.current.onRequestEdit?.();
            return false;
          },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    v.dispatch({ effects: setBreakpointsEffect.of(props.breakpoints) });
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external document replacement (examples, library, shared links)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== props.value) v.dispatch({ changes: { from: 0, to: cur.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langComp.current.reconfigure(props.language === "python" ? python() : javascript()) });
  }, [props.language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: roComp.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
    });
  }, [props.readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = breakpointLines(v.state).sort((a, b) => a - b);
    const want = props.breakpoints;
    if (cur.length !== want.length || cur.some((l, i) => l !== want[i])) v.dispatch({ effects: setBreakpointsEffect.of(want) });
  }, [props.breakpoints]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setTraceMark.of(props.traceMark) });
    if (props.traceMark && props.traceMark.line <= v.state.doc.lines) {
      const pos = v.state.doc.line(props.traceMark.line).from;
      const rect = v.lineBlockAt(pos);
      const scroller = v.scrollDOM;
      if (rect.top < scroller.scrollTop + 20 || rect.bottom > scroller.scrollTop + scroller.clientHeight - 20)
        v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }
  }, [props.traceMark?.line, props.traceMark?.kind, props.traceMark?.prevLine, props.traceMark]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const inDoc = props.diagnostics.filter((d) => d.line >= 1 && d.line <= doc.lines);
    const diags: CmDiagnostic[] = inDoc.map((d) => ({
      ...diagnosticRange(doc, d),
      severity: d.severity,
      message: `${d.kind}: ${d.message}${d.hint ? `\n${d.hint}` : ""}`,
    }));
    v.dispatch(setDiagnostics(v.state, diags));
    v.dispatch({ effects: setErrorLens.of(inDoc) });
  }, [props.diagnostics]);

  useEffect(() => {
    const v = view.current;
    const r = props.reveal;
    if (!v || !r || r.line < 1 || r.line > v.state.doc.lines) return;
    const line = v.state.doc.line(r.line);
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    v.dispatch({ selection: { anchor: line.from + indent }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    if (!v.state.readOnly) v.focus();
  }, [props.reveal]);

  return <div ref={host} className="editor-host" data-testid="editor" />;
}
