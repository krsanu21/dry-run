import { useMemo, useState } from "react";
import type { ArgConversion, RunMode } from "../trace/schema";
import { isTerminal, type Trace } from "../trace/store";
import { formatValue } from "../trace/values";
import {
  addTest,
  autoConversion,
  entryFunction,
  removeTest,
  resolvedEntry,
  run,
  runAllTests,
  selectTest,
  updateTest,
} from "./actions";
import { activeTest, store, type TestResult, useApp } from "./store";

type DockTab = "input" | "output" | "compare";

export function InputDock({ selection }: { selection: { from: number; to: number } | null }): React.JSX.Element {
  const [tab, setTab] = useState<DockTab>("input");
  const status = useApp((s) => s.run.status);
  const outcome = useApp((s) => s.run.outcome);
  return (
    <div className="dock">
      <div className="dock-tabs" role="tablist" aria-label="Input and output">
        {(["input", "output", "compare"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`dock-tab${tab === t ? " is-on" : ""}`} onClick={() => setTab(t)} data-testid={`dock-${t}`}>
            {t === "input" ? "Test case" : t === "output" ? "Output" : "Compare"}
            {t === "output" && outcome && status === "done" && <StatusDot status={outcome.summary.status} />}
          </button>
        ))}
      </div>
      <div className="dock-body" role="tabpanel">
        {tab === "input" && <InputTab selection={selection} />}
        {tab === "output" && <OutputTab />}
        {tab === "compare" && <CompareTab />}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }): React.JSX.Element {
  return <span className={`status-dot sd-${status}`} aria-label={status} />;
}

const MODES: Array<{ id: RunMode; label: string; hint: string }> = [
  { id: "function", label: "Function", hint: "Call a function or Solution method with JSON arguments" },
  { id: "script", label: "Script", hint: "Run the whole file top to bottom" },
  { id: "fragment", label: "Fragment", hint: "Run selected lines with an initial state you provide" },
];

function InputTab({ selection }: { selection: { from: number; to: number } | null }): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const analysis = useApp((s) => s.analysis);
  const test = useApp(activeTest);
  const results = useApp((s) => s.results);
  const entry = resolvedEntry();
  const fn = entryFunction(analysis, entry);
  const candidates = analysis?.entryCandidates ?? [];
  const params = fn?.params ?? test.args.map((_, i) => ({ name: `arg${i + 1}` }));
  const setMode = (mode: RunMode): void => store.updateWs({ mode });

  return (
    <div className="input-tab">
      <div className="mode-switch" role="radiogroup" aria-label="Execution mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={ws.mode === m.id} className={`seg${ws.mode === m.id ? " is-on" : ""}`} title={m.hint} onClick={() => setMode(m.id)} data-testid={`mode-${m.id}`}>
            {m.label}
          </button>
        ))}
      </div>

      {ws.mode !== "fragment" && (
        <div className="tests-row">
          {ws.tests.map((t) => {
            const r = results[t.id];
            const match = r ? resultMatch(r, t.expected) : null;
            return (
              <button key={t.id} type="button" className={`test-chip${t.id === ws.activeTestId ? " is-on" : ""}`} onClick={() => selectTest(t.id)} title={r ? `Last run: ${r.outcome?.summary.status}` : "Not run yet"}>
                {match === true && <span className="ok">✓ </span>}
                {match === false && <span className="bad">✕ </span>}
                {t.name}
              </button>
            );
          })}
          <button type="button" className="mini-btn" onClick={addTest} title="Add a test case (copies the current one)" data-testid="add-test">
            + case
          </button>
          {ws.tests.length > 1 && (
            <button type="button" className="mini-btn" onClick={() => void runAllTests()} title="Run every test case">
              Run all
            </button>
          )}
        </div>
      )}

      {ws.mode === "function" && (
        <>
          <div className="field-row">
            <label htmlFor="entry-select">Entry point</label>
            {candidates.length > 0 ? (
              <select id="entry-select" value={entry} onChange={(e) => store.updateWs({ entry: e.target.value })} data-testid="entry-select">
                {candidates.map((c) => (
                  <option key={c} value={c}>
                    {c}({entryFunction(analysis, c)?.params.map((p) => p.name).join(", ")})
                  </option>
                ))}
              </select>
            ) : (
              <span className="warn small">{analysis ? "No function or Solution method found — use Script mode for top-level code." : "Analyzing…"}</span>
            )}
            {candidates.length > 1 && <span className="dim small">{candidates.length} candidates — pick the one to call</span>}
          </div>
          <div className="test-name-row">
            <input className="test-name" value={test.name} onChange={(e) => updateTest(test.id, { name: e.target.value })} aria-label="Test case name" />
            {ws.tests.length > 1 && (
              <button type="button" className="mini-btn" onClick={() => removeTest(test.id)}>
                Delete case
              </button>
            )}
          </div>
          {params.map((p, i) => {
            const conv = test.conversions[i] ?? "auto";
            const auto = autoConversion(fn, i, ws.language);
            return (
              <div className="arg-row" key={`${p.name}-${i}`}>
                <label htmlFor={`arg-${i}`} className="arg-name">
                  {p.name}
                  {"annotation" in p && typeof p.annotation === "string" && p.annotation ? <span className="dim">: {p.annotation}</span> : null}
                </label>
                <input
                  id={`arg-${i}`}
                  className="arg-input mono"
                  value={test.args[i] ?? ""}
                  spellCheck={false}
                  placeholder="JSON value, e.g. [1, 2, 3]"
                  onChange={(e) => {
                    const args = [...test.args];
                    while (args.length <= i) args.push("");
                    args[i] = e.target.value;
                    updateTest(test.id, { args });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
                  }}
                  data-testid={`arg-${i}`}
                />
                <select
                  className="conv-select"
                  value={conv}
                  aria-label={`Convert ${p.name}`}
                  onChange={(e) => {
                    const conversions = [...test.conversions];
                    while (conversions.length <= i) conversions.push("auto");
                    conversions[i] = e.target.value as ArgConversion;
                    updateTest(test.id, { conversions });
                  }}
                >
                  <option value="auto">auto{auto.conv !== "raw" ? ` → ${auto.conv}` : ""}</option>
                  <option value="raw">JSON as-is</option>
                  <option value="linked-list">→ linked list</option>
                  <option value="binary-tree">→ binary tree (level order)</option>
                </select>
              </div>
            );
          })}
          <div className="arg-row">
            <label htmlFor="expected" className="arg-name">
              expected <span className="dim">(optional)</span>
            </label>
            <input id="expected" className="arg-input mono" value={test.expected} placeholder="JSON — compared with the actual result" onChange={(e) => updateTest(test.id, { expected: e.target.value })} data-testid="expected" />
          </div>
        </>
      )}

      {ws.mode === "script" && (
        <div className="field-col">
          <label htmlFor="stdin">Standard input (for input())</label>
          <textarea id="stdin" className="mono" rows={4} value={test.stdin} onChange={(e) => updateTest(test.id, { stdin: e.target.value })} />
          <p className="dim small">The whole file runs from top to bottom; module-level lines are traced.</p>
        </div>
      )}

      {ws.mode === "fragment" && <FragmentTab selection={selection} />}
    </div>
  );
}

function FragmentTab({ selection }: { selection: { from: number; to: number } | null }): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const f = ws.fragment;
  const lines = ws.source.split("\n");
  const total = lines.length;
  const set = (patch: Partial<typeof f>): void => store.updateWs({ fragment: { ...f, ...patch } });
  let initErr: string | null = null;
  try {
    const v: unknown = JSON.parse(f.initialState || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) initErr = "must be a JSON object: {\"name\": value}";
  } catch (e) {
    initErr = (e as Error).message;
  }
  return (
    <div className="fragment-tab">
      <div className="field-row">
        <label>Lines</label>
        <input type="number" min={1} max={total} value={f.startLine} onChange={(e) => set({ startLine: Number(e.target.value) || 1 })} aria-label="First line" className="num" />
        <span>to</span>
        <input type="number" min={1} max={total} value={f.endLine} onChange={(e) => set({ endLine: Number(e.target.value) || 1 })} aria-label="Last line" className="num" />
        <button type="button" className="mini-btn" disabled={!selection} onClick={() => selection && set({ startLine: selection.from, endLine: selection.to })} title="Select lines in the editor first" data-testid="use-selection">
          Use editor selection{selection ? ` (${selection.from}–${selection.to})` : ""}
        </button>
      </div>
      <pre className="frag-preview mono" aria-label="Fragment preview">
        {lines.slice(Math.max(0, f.startLine - 1), Math.max(f.startLine, f.endLine)).join("\n") || "(empty)"}
      </pre>
      <div className="field-col">
        <label htmlFor="frag-init">Initial state (JSON object)</label>
        <textarea id="frag-init" className={`mono${initErr ? " invalid" : ""}`} rows={4} value={f.initialState} onChange={(e) => set({ initialState: e.target.value })} spellCheck={false} data-testid="frag-init" />
        {initErr ? <span className="bad small">Invalid: {initErr}</span> : <span className="dim small">{`Special forms: {"$tuple": [...]}, {"$set": [...]}, {"$deque": [...]}, {"$linkedList": [...]}, {"$tree": [...]}`}</span>}
      </div>
      <div className="field-col">
        <label htmlFor="frag-setup">Setup code (runs untraced first)</label>
        <textarea id="frag-setup" className="mono" rows={2} value={f.setup} onChange={(e) => set({ setup: e.target.value })} spellCheck={false} placeholder={ws.language === "python" ? "from collections import deque" : "const MOD = 1e9 + 7;"} />
      </div>
      <p className="harness-note">
        Harness: the selected lines run as the body of a function whose parameters are the initial-state variables. They are <strong>not</strong> run inside your full program; missing variables raise a real NameError/ReferenceError.
      </p>
    </div>
  );
}

function resultMatch(r: TestResult, expected: string): boolean | null {
  if (!expected.trim()) return null;
  const rj = r.outcome?.summary.resultJson;
  if (rj === undefined || r.outcome?.summary.status !== "completed") return false;
  try {
    return deepEq(JSON.parse(rj), JSON.parse(expected));
  } catch {
    return rj.trim() === expected.trim();
  }
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

function OutputTab(): React.JSX.Element {
  const trace = useApp((s) => s.run.trace);
  const version = useApp((s) => s.run.version);
  const cursor = useApp((s) => s.cursor);
  const outcome = useApp((s) => s.run.outcome);
  const status = useApp((s) => s.run.status);
  const test = useApp(activeTest);
  const lang = useApp((s) => s.ws.language);
  const mode = useApp((s) => s.ws.mode);
  const prefs = useApp((s) => s.prefs.limits);
  void version;
  if (!trace) return <div className="side-empty">Output appears after a run.</div>;
  const out = trace.stdoutAt(Math.min(cursor, trace.length - 1));
  const last = trace.last;
  const summary = outcome?.summary;
  const r = summary?.resultJson;
  const match = mode === "function" && test.expected.trim() && summary ? resultMatchFromJson(r, summary.status, test.expected) : null;
  return (
    <div className="output-tab" data-testid="output">
      <div className={`run-status rs-${summary?.status ?? status}`} data-testid="run-status">
        {status !== "done" ? (
          <span>● {status === "starting" ? "starting runtime…" : `recording… ${trace.length} events`}</span>
        ) : summary ? (
          <StatusLine trace={trace} />
        ) : null}
      </div>
      {summary?.diagnostics.map((d, i) => (
        <div key={i} className={`diag diag-${d.severity}`}>
          {d.kind} (line {d.line}): {d.message}
        </div>
      ))}
      {summary?.harnessDescription && <div className="harness-note">{summary.harnessDescription}</div>}
      {mode === "function" && last && isTerminal(last) && last.type === "complete" && (
        <div className="result-block">
          <div>
            <span className="dim">Returned</span> <code data-testid="result-value">{last.result ? formatValue(last.result, last.heap, lang, { maxLength: 400, maxDepth: 6 }) : "—"}</code>
          </div>
          {test.expected.trim() && (
            <div>
              <span className="dim">Expected</span> <code>{test.expected}</code>{" "}
              {match === true ? (
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
          {r !== undefined && <div className="dim small">compared as JSON: {r}</div>}
        </div>
      )}
      {last?.type === "limit" && (
        <div className="limit-block" role="alert">
          <strong>Execution stopped:</strong> {last.limit?.message}
          <div className="dim small">
            Limits: {prefs.maxEvents} events · {(prefs.timeoutMs / 1000).toFixed(0)} s · stack {prefs.maxStackDepth}. Change them in Settings (⚙). The {trace.length - 1} recorded steps before the stop are kept.
          </div>
        </div>
      )}
      <div className="stdout-head">
        <span>stdout up to this step</span>
        <span className="dim small">{out.length} chars</span>
      </div>
      <pre className="stdout mono" data-testid="stdout">
        {out || <span className="dim">(nothing printed yet)</span>}
      </pre>
    </div>
  );
}

function resultMatchFromJson(rj: string | undefined, status: string, expected: string): boolean {
  if (rj === undefined || status !== "completed") return false;
  try {
    return deepEq(JSON.parse(rj), JSON.parse(expected));
  } catch {
    return rj.trim() === expected.trim();
  }
}

function StatusLine({ trace }: { trace: Trace }): React.JSX.Element {
  const last = trace.last;
  const s = trace.summary;
  if (!last) return <span>No events recorded{s ? ` (${s.status})` : ""}.</span>;
  if (last.type === "complete") return <span className="ok">✓ Completed · {trace.length} events · {s?.durationMs ?? 0} ms</span>;
  if (last.type === "exception")
    return (
      <span className="bad">
        ✕ {last.exception?.type}: {last.exception?.message} {last.exception?.line ? `(line ${last.exception.line})` : ""}
      </span>
    );
  if (last.type === "limit") return <span className="warn">■ Stopped: {last.limit?.message}</span>;
  return <span>{s?.status}</span>;
}

function CompareTab(): React.JSX.Element {
  const ws = useApp((s) => s.ws);
  const results = useApp((s) => s.results);
  const lang = ws.language;
  const rows = ws.tests.map((t) => ({ t, r: results[t.id] }));
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const ra = results[a];
  const rb = results[b];
  const divergence = useMemo(() => (ra && rb ? firstDivergence(ra.trace, rb.trace) : null), [ra, rb]);
  return (
    <div className="compare-tab">
      <table className="cmp-table">
        <thead>
          <tr>
            <th>Case</th>
            <th>Status</th>
            <th>Result</th>
            <th>Expected</th>
            <th>Steps</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, r }) => {
            const last = r?.trace.last;
            const m = r ? resultMatch(r, t.expected) : null;
            return (
              <tr key={t.id}>
                <td>
                  <button type="button" className="link-btn" onClick={() => selectTest(t.id)}>
                    {t.name}
                  </button>
                </td>
                <td>{r ? r.outcome?.summary.status ?? "…" : <span className="dim">not run</span>}</td>
                <td className="mono">{last?.type === "complete" && last.result ? formatValue(last.result, last.heap, lang, { maxLength: 40 }) : "—"}</td>
                <td className="mono">
                  {t.expected || "—"} {m === true ? <span className="ok">✓</span> : m === false ? <span className="bad">✕</span> : null}
                </td>
                <td>{r?.trace.length ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="field-row">
        <label>Compare traces</label>
        <select value={a} onChange={(e) => setA(e.target.value)} aria-label="First trace">
          <option value="">—</option>
          {rows.filter((x) => x.r).map(({ t }) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span>vs</span>
        <select value={b} onChange={(e) => setB(e.target.value)} aria-label="Second trace">
          <option value="">—</option>
          {rows.filter((x) => x.r).map(({ t }) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {divergence && (
        <p className="cmp-result">
          {divergence.index === -1
            ? "The two traces visit the same sequence of lines."
            : `Control flow first differs at step ${divergence.index}: line ${divergence.a ?? "end"} vs line ${divergence.b ?? "end"}.`}
        </p>
      )}
      <p className="dim small">Use “Run all” to record every case. Each case keeps its own trace; click a case name to inspect it.</p>
    </div>
  );
}

export function firstDivergence(x: Trace, y: Trace): { index: number; a?: number; b?: number } {
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const ea = x.events[i];
    const eb = y.events[i];
    if (!ea || !eb || ea.type !== eb.type || ea.loc.line !== eb.loc.line) return { index: i, ...(ea ? { a: ea.loc.line } : {}), ...(eb ? { b: eb.loc.line } : {}) };
  }
  return { index: -1 };
}
