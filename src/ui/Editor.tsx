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
});

// ---------------------------------------------------------------------------

export interface EditorProps {
  value: string;
  language: Language;
  readOnly: boolean;
  breakpoints: number[];
  traceMark: TraceMark | null;
  diagnostics: Diagnostic[];
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
    const diags: CmDiagnostic[] = props.diagnostics
      .filter((d) => d.line >= 1 && d.line <= doc.lines)
      .map((d) => {
        const line = doc.line(d.line);
        const from = Math.min(line.to, line.from + (d.column ?? 0));
        let to = line.to;
        if (d.endLine && d.endLine >= d.line && d.endLine <= doc.lines && (d.endLine !== d.line || (d.endColumn ?? 0) > (d.column ?? 0)))
          to = Math.min(doc.line(d.endLine).to, doc.line(d.endLine).from + (d.endColumn ?? 0));
        return { from, to: Math.max(from, to), severity: d.severity, message: `${d.kind}: ${d.message}` };
      });
    v.dispatch(setDiagnostics(v.state, diags));
  }, [props.diagnostics]);

  return <div ref={host} className="editor-host" data-testid="editor" />;
}
