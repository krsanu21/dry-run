import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { closeHoverTooltips, EditorView, hoverTooltip, keymap, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";
import { expressionAt, type PeekHighlight, type PeekModel } from "../trace/peek";
import type { Language } from "../trace/schema";
import { peekAnnouncement, renderPeek } from "./peekDom";

/**
 * Trace Peek in the code editor.
 *
 *  - mouse:    hover a variable (a short delay avoids flicker while moving across the code)
 *  - keyboard: put the caret on a variable and press F2 or Ctrl/⌘+. ; Esc closes;
 *              Alt+← / Alt+→ / Alt+↓ step the trace and the open peek follows
 *  - touch:    tap a variable to pin its peek; tap it again, tap elsewhere, or use × to close
 *
 * The tooltip's content is always `provider.query(...)`, i.e. a pure read of the recorded
 * snapshot for the step that is selected right now. When that step changes the open tooltips
 * are rebuilt, so a value on screen is never from a different step than the one selected.
 */

export interface PeekProvider {
  /** changes whenever the displayed step or selected call changes */
  epoch: string;
  /** the code was edited after the run */
  stale: boolean;
  query(line: number, head: string, expr: string): PeekModel | null;
  onHighlight(h: PeekHighlight | null): void;
  goto(step: number): void;
  step(kind: "into" | "back" | "over"): void;
}

interface Pinned {
  from: number;
  to: number;
  line: number;
  head: string;
  expr: string;
  /** bumped to rebuild the tooltip after the step changed */
  rev: number;
  /** opened by touch: larger controls */
  touch: boolean;
}

const setPinned = StateEffect.define<Pinned | null>();
const refreshPinned = StateEffect.define<null>();

const pinnedField = StateField.define<Pinned | null>({
  create: () => null,
  update(v, tr) {
    if (tr.docChanged) return null;
    for (const e of tr.effects) {
      if (e.is(setPinned)) return e.value;
      if (e.is(refreshPinned) && v) return { ...v, rev: v.rev + 1 };
    }
    return v;
  },
});

export interface PeekHooks {
  provider(): PeekProvider | null | undefined;
  language(): Language;
  /** announce text to assistive technology */
  announce(text: string): void;
}

export function peekExtension(hooks: PeekHooks): { extensions: Extension[]; refresh(view: EditorView): void } {
  // only the most recently built tooltip may clear the highlight when it goes away
  let token = 0;

  const build = (view: EditorView, model: PeekModel | null, name: string, pinned: boolean, touch: boolean): TooltipView => {
    const provider = hooks.provider();
    const myToken = ++token;
    const shown: PeekModel = model ?? {
      status: "unresolved",
      expr: name,
      head: name,
      rows: [],
      rowsMore: 0,
      notes: [],
      aliases: [],
      others: [],
      history: [],
      mutatedAt: [],
      message: `${name} is not a variable at this step.`,
      moment: "",
      stepIndex: 0,
      line: 0,
    };
    const dom = renderPeek(shown, {
      pinned,
      close: () => view.dispatch({ effects: setPinned.of(null) }),
      goto: (step) => provider?.goto(step),
    });
    if (touch) dom.classList.add("is-touch");
    provider?.onHighlight(shown.highlight ?? null);
    if (pinned) hooks.announce(peekAnnouncement(shown));
    return {
      dom,
      destroy: () => {
        if (token === myToken) hooks.provider()?.onHighlight(null);
      },
    };
  };

  const hover = hoverTooltip(
    (view, pos): Tooltip | null => {
      const provider = hooks.provider();
      // a pinned peek stays the only one on screen
      if (!provider || view.state.field(pinnedField)) return null;
      const line = view.state.doc.lineAt(pos);
      const at = expressionAt(line.text, pos - line.from, hooks.language());
      if (!at) return null;
      const model = provider.query(line.number, at.head, at.expr);
      if (!model) return null;
      return {
        pos: line.from + at.from,
        end: line.from + at.to,
        above: true,
        create: (view) => build(view, model, at.expr, false, false),
      };
    },
    { hoverTime: 280, hideOnChange: true },
  );

  const pinnedTooltip = showTooltip.compute([pinnedField], (state): Tooltip | null => {
    const p = state.field(pinnedField);
    if (!p) return null;
    return {
      pos: p.from,
      end: p.to,
      above: true,
      arrow: true,
      create: (view) => build(view, hooks.provider()?.query(p.line, p.head, p.expr) ?? null, p.expr, true, p.touch),
    };
  });

  const pinAt = (view: EditorView, pos: number, touch: boolean): boolean => {
    const line = view.state.doc.lineAt(pos);
    const at = expressionAt(line.text, pos - line.from, hooks.language());
    const cur = view.state.field(pinnedField);
    if (!at) {
      if (cur) view.dispatch({ effects: setPinned.of(null) });
      else hooks.announce("No variable here to peek at.");
      return !!cur || !touch;
    }
    const from = line.from + at.from;
    if (cur && cur.from === from && cur.expr === at.expr) {
      view.dispatch({ effects: setPinned.of(null) }); // same spot again: close
      return true;
    }
    view.dispatch({ effects: [closeHoverTooltips, setPinned.of({ from, to: line.from + at.to, line: line.number, head: at.head, expr: at.expr, rev: 0, touch })] });
    return true;
  };

  const peekAtCaret = (view: EditorView): boolean => {
    if (!hooks.provider()) return false;
    return pinAt(view, view.state.selection.main.head, false);
  };

  const keys = keymap.of([
    { key: "F2", run: peekAtCaret },
    { key: "Mod-.", run: peekAtCaret },
    {
      key: "Escape",
      run: (view) => {
        if (!view.state.field(pinnedField)) return false;
        view.dispatch({ effects: setPinned.of(null) });
        return true;
      },
    },
    // stepping from inside the editor (arrow keys move the caret here, so plain arrows cannot step)
    ...(["into", "back", "over"] as const).map((kind) => ({
      key: kind === "into" ? "Alt-ArrowRight" : kind === "back" ? "Alt-ArrowLeft" : "Alt-ArrowDown",
      run: (view: EditorView): boolean => {
        const p = hooks.provider();
        if (!p || p.stale) return false;
        p.step(kind);
        return true;
      },
    })),
  ]);

  // touch: a tap on a variable pins its peek (a tap elsewhere closes it). Scrolling produces
  // pointercancel, not pointerup, so only real taps get here.
  const touch = EditorView.domEventHandlers({
    pointerup: (e, view) => {
      if ((e.pointerType !== "touch" && e.pointerType !== "pen") || !hooks.provider()) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) {
        if (view.state.field(pinnedField)) view.dispatch({ effects: setPinned.of(null) });
        return false;
      }
      return pinAt(view, pos, true);
    },
  });

  return {
    extensions: [pinnedField, pinnedTooltip, hover, keys, touch],
    refresh: (view) => view.dispatch({ effects: [closeHoverTooltips, refreshPinned.of(null)] }),
  };
}
