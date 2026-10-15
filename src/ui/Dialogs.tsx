import { useEffect, useRef, useState } from "react";
import { EXAMPLES } from "../examples";
import { clearAllLocalData, deleteSolution, listSolutions, saveSolution } from "../persistence/db";
import { encodeShare, MAX_URL_LENGTH, type SharePayload, validatePayload } from "../persistence/share";
import { DEFAULT_LIMITS, type TraceLimits } from "../trace/schema";
import { loadExample, loadWorkspace } from "./actions";
import { DEFAULT_PREFS, newTest, store, type TestCase, toast, uid, useApp, type Workspace } from "./store";

function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: React.ReactNode; wide?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, input, select, textarea, a[href]")?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="mini-btn" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const close = (): void => store.set({ dialog: null });

export function Dialogs(): React.JSX.Element | null {
  const dialog = useApp((s) => s.dialog);
  switch (dialog) {
    case "examples":
      return <ExamplesDialog />;
    case "library":
      return <LibraryDialog />;
    case "settings":
      return <SettingsDialog />;
    case "share":
      return <ShareDialog />;
    case "shortcuts":
      return <ShortcutsDialog />;
    default:
      return null;
  }
}

function ExamplesDialog(): React.JSX.Element {
  const topics = [...new Set(EXAMPLES.map((e) => e.topic))];
  return (
    <Modal title="Built-in examples" onClose={close} wide>
      <p className="dim">Each example is real code traced live — including unfinished and buggy variants to practise debugging.</p>
      <div className="examples-grid">
        {topics.map((t) => (
          <div key={t} className="ex-group">
            <h3>{t}</h3>
            {EXAMPLES.filter((e) => e.topic === t).map((e) => (
              <button key={e.id} type="button" className="ex-item" onClick={() => loadExample(e.id)} data-testid={`example-${e.id}`}>
                <span className="ex-title">{e.title}</span>
                <span className="ex-tags">
                  <span className={`tag tag-${e.language}`}>{e.language === "python" ? "Py" : "JS"}</span>
                  {e.stage !== "complete" && <span className={`tag tag-${e.stage}`}>{e.stage}</span>}
                </span>
                <span className="ex-watch dim">{e.watch}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function LibraryDialog(): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [title, setTitle] = useState(ws.title);
  const refresh = (): void => void listSolutions().then(setItems);
  useEffect(refresh, []);
  return (
    <Modal title="Saved solutions (this browser only)" onClose={close} wide>
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault();
          const saved = { ...ws, title: title.trim() || "Untitled", updatedAt: Date.now() };
          store.updateWs({ title: saved.title });
          void saveSolution(saved).then((ok) => {
            toast(ok ? `Saved “${saved.title}” with ${saved.tests.length} test case(s).` : "Could not save: browser storage is unavailable.", ok ? "info" : "error");
            refresh();
          });
        }}
      >
        <label htmlFor="save-title">Title</label>
        <input id="save-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" className="btn primary" data-testid="save-solution">
          Save current
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const copy = { ...ws, id: uid(), title: `${title || ws.title} (copy)`, updatedAt: Date.now() };
            void saveSolution(copy).then(refresh);
            store.set({ ws: copy });
          }}
        >
          Save as copy
        </button>
      </form>
      {items === null ? (
        <p className="dim">Loading…</p>
      ) : items.length === 0 ? (
        <p className="dim">Nothing saved yet.</p>
      ) : (
        <table className="lib-table">
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className={it.id === ws.id ? "is-current" : ""}>
                <td>
                  <button type="button" className="link-btn" onClick={() => loadWorkspace(it)}>
                    {it.title}
                  </button>
                </td>
                <td className="dim">{it.language}</td>
                <td className="dim">{it.tests.length} case(s)</td>
                <td className="dim">{new Date(it.updatedAt).toLocaleString()}</td>
                <td>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => {
                      if (confirm(`Delete “${it.title}” from this browser?`)) void deleteSolution(it.id).then(refresh);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="danger-zone">
        <p className="dim small">Solutions, test cases, and preferences are stored only in this browser (IndexedDB + localStorage).</p>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (confirm("Delete ALL locally stored solutions, test cases and preferences?")) {
              void clearAllLocalData().then(() => {
                toast("All local data deleted.");
                refresh();
              });
            }
          }}
        >
          Delete all local data
        </button>
      </div>
    </Modal>
  );
}

function SettingsDialog(): React.JSX.Element {
  const prefs = useApp((s) => s.prefs);
  const setLimit = (k: keyof TraceLimits, v: number): void => store.set((s) => ({ prefs: { ...s.prefs, limits: { ...s.prefs.limits, [k]: v } } }));
  const limits: Array<[keyof TraceLimits, string, string]> = [
    ["maxEvents", "Step limit", "The run stops after recording this many steps (useful for loops that never end)."],
    ["timeoutMs", "Time limit (ms)", "Enforced by the tracer and by a watchdog that terminates the worker."],
    ["maxStackDepth", "Max stack depth", "Deep recursion stops cleanly before the engine overflows."],
    ["maxDepth", "Snapshot nesting depth", "Objects nested deeper are shown as “not captured”."],
    ["maxItems", "Items per collection", "Longer collections are visibly truncated."],
    ["maxObjects", "Objects per snapshot", "Snapshot budget; extra objects are marked “not captured”."],
    ["maxString", "Characters per string", "Longer strings are cut with a visible marker."],
  ];
  return (
    <Modal title="Settings" onClose={close}>
      <fieldset>
        <legend>Appearance</legend>
        <div className="field-row">
          <label htmlFor="theme">Theme</label>
          <select id="theme" value={prefs.theme} onChange={(e) => store.set((s) => ({ prefs: { ...s.prefs, theme: e.target.value as typeof prefs.theme } }))}>
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div className="field-row">
          <label htmlFor="motion">Motion</label>
          <select id="motion" value={prefs.motion} onChange={(e) => store.set((s) => ({ prefs: { ...s.prefs, motion: e.target.value as typeof prefs.motion } }))}>
            <option value="system">Follow system (prefers-reduced-motion)</option>
            <option value="reduced">Reduced</option>
            <option value="full">Full</option>
          </select>
        </div>
      </fieldset>
      <fieldset>
        <legend>Execution limits</legend>
        {limits.map(([k, label, hint]) => (
          <div className="field-row" key={k}>
            <label htmlFor={`lim-${k}`} title={hint}>
              {label}
            </label>
            <input id={`lim-${k}`} type="number" min={1} className="num" value={prefs.limits[k]} onChange={(e) => setLimit(k, Math.max(1, Number(e.target.value) || DEFAULT_LIMITS[k]))} data-testid={`lim-${k}`} />
            <span className="dim small">{hint}</span>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => store.set((s) => ({ prefs: { ...s.prefs, limits: { ...DEFAULT_PREFS.limits } } }))}>
          Reset limits
        </button>
        <p className="dim small">Memory is not strictly limited: browsers do not expose per-worker memory caps. Snapshot budgets bound what Dry Run records; the watchdog bounds time.</p>
      </fieldset>
    </Modal>
  );
}

function ShareDialog(): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const [url, setUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const payload: SharePayload = {
    v: 1,
    language: ws.language,
    source: ws.source,
    target: ws.target,
    title: ws.title,
    tests: ws.tests.map((t) => ({ args: t.args, expected: t.expected })),
    conversions: ws.conversions,
    stdin: ws.stdin,
  };
  useEffect(() => {
    void encodeShare(payload).then((tok) => setUrl(`${location.origin}${location.pathname}#share=${tok}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tooLong = url !== null && url.length > MAX_URL_LENGTH;
  const copy = (text: string, what: string): void =>
    void navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied.`),
      () => {
        inputRef.current?.select();
        toast("Your browser blocked copying — the link is selected, press ⌘C / Ctrl+C.", "error");
      },
    );
  const download = (): void => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(ws.title || "dry-run").replace(/[^\w-]+/g, "_")}.dryrun.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const n = ws.tests.length;
  return (
    <Modal title="Share or export" onClose={close}>
      <p className="dim">
        Shares the code exactly as it is in the editor now, with {n === 1 ? "its test case" : `all ${n} test cases`} — no need to save first. Opening the link never runs anything.
      </p>
      {url === null ? (
        <p>Encoding…</p>
      ) : tooLong ? (
        <p className="warn">This solution is too large for a link ({url.length} characters; limit {MAX_URL_LENGTH}). Export a file instead.</p>
      ) : (
        <div className="field-col">
          <input
            ref={inputRef}
            readOnly
            value={url}
            className="mono"
            aria-label="Share URL"
            onFocus={(e) => e.target.select()}
            data-testid="share-url"
          />
          <div className="field-row">
            <button type="button" className="btn primary" onClick={() => copy(url, "Link")} data-testid="share-copy">
              Copy link
            </button>
            <span className="dim small">{url.length} characters · if a chat app cuts it off, send the .json file instead</span>
          </div>
        </div>
      )}
      <div className="field-row">
        <button type="button" className="btn" onClick={download}>
          Export .json file
        </button>
        <label className="btn">
          Import file…
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void f.text().then((text) => {
                try {
                  const p = validatePayload(JSON.parse(text));
                  store.set({ sharedPending: payloadToWorkspace(p), dialog: null });
                } catch (err) {
                  toast(`Import failed: ${(err as Error).message}`, "error");
                }
              });
            }}
          />
        </label>
      </div>
    </Modal>
  );
}

export function payloadToWorkspace(p: SharePayload): Workspace {
  const tests = p.tests.map((t) => newTest(t.args, t.expected));
  return {
    id: uid(),
    title: p.title,
    language: p.language,
    source: p.source,
    target: p.target,
    tests,
    activeTestId: (tests[0] as TestCase).id,
    conversions: p.conversions,
    stdin: p.stdin,
    breakpoints: [],
    updatedAt: Date.now(),
  };
}

export const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl/⌘ + Enter", "Run (works inside the editor too)"],
  ["R", "Run again"],
  ["→", "Next — the next step, going into calls"],
  ["←", "Back one step"],
  ["↓", "Next line in this function, skipping over calls"],
  ["↑", "Previous line in this function"],
  ["Shift + ↓", "Finish this call and return to the caller"],
  ["Space", "Play / pause"],
  ["Home / End", "Jump to start / end"],
  ["N / Shift + N", "Next / previous breakpoint"],
  ["B", "Toggle a breakpoint on the current line"],
  ["F9 (in editor)", "Toggle a breakpoint on the cursor line"],
  ["E", "Edit the code"],
  ["P", "Practice: guess each step before it is shown"],
  ["Enter", "Submit a guess / next guess"],
  ["Hover a variable", "Peek: its value at this step"],
  ["F2 or Ctrl/⌘ + .", "Peek at the variable under the caret (Esc closes)"],
  ["Alt + ← / → / ↓", "Back / Next / Next line while the caret is in the code"],
  ["Tap a variable", "Touch: pin its peek; tap again or × to close"],
  ["1 – 4", "Narrow screens: Code / Visual / Variables / Stack"],
  ["?", "Show this sheet"],
  ["Esc", "Close dialogs; stop a running program"],
];

function ShortcutsDialog(): React.JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" onClose={close}>
      <p className="dim small">Shortcuts are ignored while you type in the editor or a text field (except Ctrl/⌘+Enter).</p>
      <table className="kbd-table">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
