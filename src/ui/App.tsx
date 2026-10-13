import { useEffect, useMemo, useRef, useState } from "react";
import { loadCurrent, loadPrefs, saveCurrent, savePrefs } from "../persistence/db";
import { decodeShare, shareTokenFromHash } from "../persistence/share";
import type { Diagnostic } from "../trace/schema";
import * as nav from "../trace/navigation";
import { activeFrame, isTerminal } from "../trace/store";
import { VizContext, type VizContextValue } from "../viz/views/common";
import {
  cancelRun,
  getAdapters,
  goto,
  loadWorkspace,
  nextBreakpoint,
  prevBreakpoint,
  run,
  scheduleAnalysis,
  setBreakpoints,
  setLanguage,
  setPredictionEnabled,
  setSource,
  stepBack,
  stepBackOver,
  stepInto,
  stepOut,
  stepOver,
  toEnd,
  toggleBreakpoint,
  togglePlay,
  toStart,
} from "./actions";
import { Canvas } from "./Canvas";
import { Dialogs, payloadToWorkspace } from "./Dialogs";
import { CodeEditor, type EditorDiagnostic, type TraceMark } from "./Editor";
import { errorHint } from "./errorHints";
import { CallStackPanel, HistoryPanel, InspectPanel, VariablesPanel, WatchPanel } from "./Inspector";
import { InputDock } from "./InputDock";
import { PredictionPanel, predictionKeySubmit } from "./Prediction";
import { DEFAULT_PREFS, type MobileTab, store, useApp } from "./store";
import { TraceBar } from "./TraceBar";
import { useCurrentStep } from "./useTrace";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof (el as { closest?: unknown }).closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable='true'], .cm-editor");
}

export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void run();
        return;
      }
      if (e.key === "Escape") {
        const st = store.get();
        if (st.dialog) store.set({ dialog: null });
        else if (st.run.status === "running" || st.run.status === "starting") cancelRun();
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (store.get().dialog) return;
      const s = store.get();
      const handled = ((): boolean => {
        switch (e.key) {
          case "ArrowRight":
            stepInto();
            return true;
          case "ArrowLeft":
            stepBack();
            return true;
          case "ArrowDown":
            if (e.shiftKey) stepOut();
            else stepOver();
            return true;
          case "ArrowUp":
            stepBackOver();
            return true;
          case " ":
            togglePlay();
            return true;
          case "Home":
            toStart();
            return true;
          case "End":
            toEnd();
            return true;
          case "n":
            nextBreakpoint();
            return true;
          case "N":
            prevBreakpoint();
            return true;
          case "b": {
            const ev = s.run.trace?.events[s.cursor];
            const line = ev ? activeFrame(ev)?.line ?? ev.loc.line : null;
            if (line) toggleBreakpoint(line);
            return !!line;
          }
          case "r":
            void run();
            return true;
          case "e":
            store.set({ editing: true, mobileTab: "code" });
            return true;
          case "p":
            setPredictionEnabled(!s.prediction.enabled);
            return true;
          case "Enter":
            return predictionKeySubmit();
          case "?":
            store.set({ dialog: "shortcuts" });
            return true;
          case "1":
          case "2":
          case "3":
          case "4":
            store.set({ mobileTab: (["code", "viz", "vars", "stack"] as const)[Number(e.key) - 1] as MobileTab });
            return true;
          default:
            return false;
        }
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(q);
    const on = (): void => setM(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [q]);
  return m;
}

function useTheme(): boolean {
  const theme = useApp((s) => s.prefs.theme);
  const motion = useApp((s) => s.prefs.motion);
  const [systemReduced, setSystemReduced] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = (): void => setSystemReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  const reduced = motion === "reduced" || (motion === "system" && systemReduced);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    root.toggleAttribute("data-reduced-motion", reduced);
  }, [theme, reduced]);
  return reduced;
}

function usePersistence(): void {
  useEffect(() => {
    const prefs = loadPrefs();
    if (prefs) store.set({ prefs: { ...DEFAULT_PREFS, ...prefs, limits: { ...DEFAULT_PREFS.limits, ...(prefs.limits ?? {}) } } });
    const cur = loadCurrent();
    if (cur) store.set({ ws: cur });
    // Shared links are decoded and validated, then shown for confirmation — never auto-run.
    const openShared = (): void => {
      const token = shareTokenFromHash(location.hash);
      if (!token) return;
      void decodeShare(token)
        .then((p) => store.set({ sharedPending: payloadToWorkspace(p) }))
        .catch((e: Error) => store.set({ toast: { text: `Could not open shared link: ${e.message}`, kind: "error" } }));
    };
    openShared();
    window.addEventListener("hashchange", openShared);
    scheduleAnalysis(0);
    getAdapters().python.warmup?.();
    let t: ReturnType<typeof setTimeout> | undefined;
    let lastWs = store.get().ws;
    let lastPrefs = store.get().prefs;
    const unsub = store.subscribe(() => {
      const s = store.get();
      if (s.prefs !== lastPrefs) {
        lastPrefs = s.prefs;
        savePrefs(s.prefs);
      }
      if (s.ws !== lastWs) {
        lastWs = s.ws;
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          t = undefined;
          saveCurrent(store.get().ws);
        }, 400);
      }
    });
    // Never lose the last edits when the tab is closed or reloaded inside the debounce window.
    const flush = (): void => {
      if (t) {
        clearTimeout(t);
        t = undefined;
        saveCurrent(store.get().ws);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      unsub();
      flush();
      window.removeEventListener("hashchange", openShared);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
}

function TopBar(): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const status = useApp((s) => s.run.status);
  const ready = useApp((s) => s.runtimeReady);
  const theme = useApp((s) => s.prefs.theme);
  const recording = status === "starting" || status === "running";
  return (
    <header className="topbar">
      <div className="brand" aria-label="Dry Run">
        <span className="brand-mark" aria-hidden>
          ▸▸
        </span>
        dry run
      </div>
      <div className="tb-group">
        <select value={ws.language} onChange={(e) => setLanguage(e.target.value as "python" | "javascript")} aria-label="Language" data-testid="language">
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
        </select>
        <span className="tb-title" title={ws.title}>
          {ws.title}
        </span>
      </div>
      <div className="tb-group tb-actions">
        <button type="button" className="btn" onClick={() => store.set({ dialog: "examples" })} data-testid="open-examples">
          Examples
        </button>
        <button type="button" className="btn wide-only" onClick={() => store.set({ dialog: "library" })}>
          Saved
        </button>
        <button type="button" className="btn wide-only" onClick={() => store.set({ dialog: "share" })}>
          Share
        </button>
        {recording ? (
          <button type="button" className="btn danger" onClick={cancelRun} data-testid="stop">
            ■ Stop
          </button>
        ) : (
          <button type="button" className="btn primary run-btn" onClick={() => void run()} data-testid="run" title="Run (Ctrl/⌘+Enter)">
            ▶ Run
          </button>
        )}
        {ws.language === "python" && !ready && !recording && (
          <span className="rt-status dim small" title="The Python runtime loads locally in the background">
            loading Python…
          </span>
        )}
        <details className="more-menu narrow-only">
          <summary className="icon-btn" aria-label="More actions">
            ⋯
          </summary>
          <div className="more-body" role="menu">
            {(
              [
                ["library", "Saved solutions"],
                ["share", "Share / export"],
                ["settings", "Settings"],
                ["shortcuts", "Keyboard shortcuts"],
              ] as const
            ).map(([d, label]) => (
              <button
                key={d}
                type="button"
                role="menuitem"
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                  store.set({ dialog: d });
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </details>
        <button
          type="button"
          className="icon-btn"
          onClick={() => store.set((s) => ({ prefs: { ...s.prefs, theme: theme === "light" ? "dark" : theme === "dark" ? "system" : "light" } }))}
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme} (click to change)`}
        >
          {theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}
        </button>
        <button type="button" className="icon-btn wide-only" onClick={() => store.set({ dialog: "settings" })} aria-label="Settings" title="Settings">
          ⚙
        </button>
        <button type="button" className="icon-btn wide-only" onClick={() => store.set({ dialog: "shortcuts" })} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          ?
        </button>
      </div>
    </header>
  );
}

function SharedBanner(): React.JSX.Element | null {
  const pending = useApp((s) => s.sharedPending);
  if (!pending) return null;
  return (
    <div className="shared-banner" role="alert" data-testid="shared-banner">
      <span>
        Shared {pending.language === "python" ? "Python" : "JavaScript"} solution “{pending.title}” ({pending.source?.split("\n").length ?? 0} lines). It has <strong>not</strong> been run.
      </span>
      <button
        type="button"
        className="btn primary"
        onClick={() => {
          loadWorkspace(pending as Parameters<typeof loadWorkspace>[0]);
          store.set({ sharedPending: null });
          history.replaceState(null, "", location.pathname + location.search);
        }}
        data-testid="shared-load"
      >
        Load into editor
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          store.set({ sharedPending: null });
          history.replaceState(null, "", location.pathname + location.search);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

function EditorPane({ onSelection }: { onSelection(r: { from: number; to: number } | null): void }): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const editing = useApp((s) => s.editing);
  const analysis = useApp((s) => s.analysis);
  const outcome = useApp((s) => s.run.outcome);
  const sourceAtRun = useApp((s) => s.run.sourceAtRun);
  const step = useCurrentStep();
  const hasTrace = !!step;
  const stale = hasTrace && sourceAtRun !== ws.source;
  const readOnly = hasTrace && !editing;
  const runStale = sourceAtRun !== ws.source;
  const [reveal, setReveal] = useState<{ line: number; n: number } | null>(null);
  const diagnostics: EditorDiagnostic[] = useMemo(() => {
    const withHint = (d: Diagnostic, note?: string): EditorDiagnostic => {
      const hint = errorHint(d.kind, d.message, ws.language);
      return { ...d, ...(hint ? { hint } : {}), ...(note ? { note } : {}) };
    };
    // Live analysis always matches the current text.
    const out = (analysis?.diagnostics ?? []).map((d) => withHint(d));
    // Results of the last run only describe the code as it was then; once the code changes their line numbers can be wrong.
    if (!runStale) {
      for (const d of outcome?.summary.diagnostics ?? []) if (!out.some((x) => x.line === d.line && x.message === d.message)) out.push(withHint(d));
      const tr = step?.trace;
      const last = tr?.last;
      if (tr && last?.type === "exception" && last.exception?.uncaught && last.exception.line)
        out.push(
          withHint(
            { severity: "error", kind: last.exception.type, message: last.exception.message, line: last.exception.line },
            `raised at step ${Math.max(0, nav.errorOrigin(tr))}`,
          ),
        );
    }
    return out;
  }, [analysis, outcome, step?.trace, runStale, ws.language]);
  const problems = diagnostics.filter((d) => d.severity === "error");
  const firstProblem = problems[0];
  const revealError = useApp((s) => s.revealError);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!revealError || !firstProblem) return;
    setReveal((r) => ({ line: firstProblem.line, n: (r?.n ?? 0) + 1 }));
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealError]);
  const lastEvent = step?.trace.last;
  const runtimeError = !runStale && lastEvent?.type === "exception" && lastEvent.exception?.uncaught ? lastEvent : null;
  const atRuntimeError = !!runtimeError && !!step && (step.index === nav.errorOrigin(step.trace) || step.index === runtimeError.index);
  const traceMark: TraceMark | null = useMemo(() => {
    if (!step || stale) return null;
    const ev = step.event;
    const f = step.frame;
    const line = f && step.frame?.id !== activeFrame(ev)?.id ? f.line : ev.loc.line;
    const kind: TraceMark["kind"] = isTerminal(ev) ? "done" : ev.type === "call" ? "call" : ev.type === "return" ? "return" : ev.type === "exception" ? "exception" : "next";
    const prevLine = step.prev && step.prev.type === "line" ? step.prev.loc.line : undefined;
    return { line, kind, ...(prevLine !== undefined ? { prevLine } : {}) };
  }, [step, stale]);
  return (
    <div className={`editor-pane${readOnly ? " is-readonly" : ""}${flash ? " flash-error" : ""}`}>
      <div className="editor-head">
        {readOnly ? (
          <>
            <span className="mode-pill tracing">● Tracing (read-only)</span>
            <button type="button" className="mini-btn" onClick={() => store.set({ editing: true })} data-testid="edit-code">
              Edit code <kbd>E</kbd>
            </button>
          </>
        ) : (
          <>
            <span className="mode-pill">Editing</span>
            {hasTrace && (
              <button type="button" className="mini-btn" onClick={() => store.set({ editing: false })}>
                Back to trace
              </button>
            )}
          </>
        )}
        {stale && (
          <span className="stale-note">
            Code changed since this trace —{" "}
            <button type="button" className="link-btn" onClick={() => void run()}>
              re-run
            </button>
          </span>
        )}
        {firstProblem ? (
          <span className="problem-bar" data-testid="problem-bar">
            <button
              type="button"
              className="problem-btn"
              onClick={() => setReveal((r) => ({ line: firstProblem.line, n: (r?.n ?? 0) + 1 }))}
              title="Show this line"
            >
              <span className="problem-icon" aria-hidden="true">
                ✕
              </span>
              <b>{firstProblem.kind}</b> line {firstProblem.line}
              {problems.length > 1 && <span className="dim"> · +{problems.length - 1} more</span>}
            </button>
            {runtimeError && !atRuntimeError && (
              <button type="button" className="mini-btn" onClick={() => step && goto(nav.errorOrigin(step.trace))} data-testid="goto-error-step">
                Go to error step
              </button>
            )}
          </span>
        ) : (
          <span className="dim small editor-hint">click a line number to toggle a breakpoint</span>
        )}
      </div>
      <CodeEditor
        value={ws.source}
        language={ws.language}
        readOnly={readOnly}
        breakpoints={ws.breakpoints}
        traceMark={traceMark}
        diagnostics={diagnostics}
        reveal={reveal}
        onChange={setSource}
        onToggleBreakpoint={toggleBreakpoint}
        onBreakpointsMoved={setBreakpoints}
        onSelectionLines={onSelection}
        onRequestEdit={() => undefined}
      />
    </div>
  );
}

type SideTab = "vars" | "watch" | "history" | "predict";

function SidePanel({ only }: { only?: "vars" | "stack" }): React.JSX.Element {
  const [tab, setTab] = useState<SideTab>("vars");
  const historyVar = useApp((s) => s.historyVar);
  const predEnabled = useApp((s) => s.prediction.enabled);
  useEffect(() => {
    if (historyVar) setTab("history");
  }, [historyVar]);
  useEffect(() => {
    if (predEnabled) setTab("predict");
  }, [predEnabled]);
  return (
    <div className="side">
      {only !== "vars" && (
        <section className="side-section stack-section" aria-label="Call stack">
          <h3 className="side-h">Call stack</h3>
          <CallStackPanel />
        </section>
      )}
      {only !== "stack" && (
        <section className="side-section grow" aria-label="Inspector">
          <div className="side-tabs" role="tablist">
            {(
              [
                ["vars", "Variables"],
                ["watch", "Watch"],
                ["history", "History"],
                ["predict", "Predict"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={`side-tab${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)} data-testid={`side-${id}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="side-body">
            {tab === "vars" && (
              <>
                <InspectPanel />
                <VariablesPanel />
              </>
            )}
            {tab === "watch" && <WatchPanel />}
            {tab === "history" && <HistoryPanel />}
            {tab === "predict" && <PredictionPanel />}
          </div>
        </section>
      )}
    </div>
  );
}

function Resizer({ onDrag, label }: { onDrag(dx: number): void; label: string }): React.JSX.Element {
  const start = useRef<number | null>(null);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onDrag(-24);
        if (e.key === "ArrowRight") onDrag(24);
      }}
      onPointerDown={(e) => {
        start.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        onDrag(e.clientX - start.current);
        start.current = e.clientX;
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    />
  );
}

export function App(): React.JSX.Element {
  useKeyboard();
  usePersistence();
  const reducedMotion = useTheme();
  const step = useCurrentStep();
  const language = useApp((s) => s.ws.language);
  const heatmap = useApp((s) => s.prefs.heatmap);
  const left = useApp((s) => s.prefs.leftWidth);
  const right = useApp((s) => s.prefs.rightWidth);
  const mobileTab = useApp((s) => s.mobileTab);
  const toastMsg = useApp((s) => s.toast);
  const runStatus = useApp((s) => s.run.status);
  const narrow = useMediaQuery("(max-width: 820px)");
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);

  const vizCtx: VizContextValue | null = useMemo(
    () =>
      step
        ? {
            event: step.state,
            prev: step.final ? undefined : step.prev,
            diff: step.diff,
            language,
            refCounts: step.refCounts,
            firstSeen: step.trace.objectFirstSeen,
            heatmap,
            reducedMotion,
            onInspect: (id: string) => store.set({ inspectId: id }),
          }
        : null,
    [step, language, heatmap, reducedMotion],
  );

  const resize = (which: "leftWidth" | "rightWidth", dx: number): void =>
    store.set((s) => ({
      prefs: {
        ...s.prefs,
        [which]: Math.max(260, Math.min(900, s.prefs[which] + (which === "leftWidth" ? dx : -dx))),
      },
    }));

  return (
    <div className={`app mobile-${mobileTab}`} data-run-status={runStatus} style={{ ["--left" as string]: `${left}px`, ["--right" as string]: `${right}px` }}>
      <TopBar />
      <div className="banner-slot">
        <SharedBanner />
      </div>
      <VizContext.Provider value={vizCtx}>
        <main className="workspace">
          <div className="col col-left" data-mobile="code">
            <EditorPane onSelection={setSelection} />
            <InputDock selection={selection} />
          </div>
          <Resizer label="Resize editor" onDrag={(dx) => resize("leftWidth", dx)} />
          <div className="col col-center" data-mobile="viz">
            <Canvas />
          </div>
          <Resizer label="Resize inspector" onDrag={(dx) => resize("rightWidth", dx)} />
          <div className="col col-right">
            <div className="side-wrap">{narrow ? <SidePanel only={mobileTab === "stack" ? "stack" : "vars"} /> : <SidePanel />}</div>
          </div>
        </main>
      </VizContext.Provider>
      <TraceBar />
      <nav className="mobile-tabs" aria-label="Panels">
        {(
          [
            ["code", "Code"],
            ["viz", "Visual"],
            ["vars", "Variables"],
            ["stack", "Stack"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={mobileTab === id ? "is-on" : ""} aria-pressed={mobileTab === id} onClick={() => store.set({ mobileTab: id })} data-testid={`mtab-${id}`}>
            {label}
          </button>
        ))}
      </nav>
      <Dialogs />
      {toastMsg && (
        <div className={`toast toast-${toastMsg.kind}`} role="status" data-testid="toast">
          {toastMsg.text}
        </div>
      )}
    </div>
  );
}
