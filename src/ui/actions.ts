import type { FunctionInfo, SourceAnalysis } from "../analysis/types";
import { JavaScriptAdapter } from "../adapters/javascript/adapter";
import { PythonAdapter } from "../adapters/python/adapter";
import type { LanguageAdapter, RunHandle } from "../adapters/types";
import { exampleById } from "../examples";
import type { ArgConversion, ExecutionRequest, Language, TraceEvent, Value } from "../trace/schema";
import { Trace, isTerminal } from "../trace/store";
import * as nav from "../trace/navigation";
import { formatValue, toPlain } from "../trace/values";
import {
  activeTest,
  newTest,
  type PredictionField,
  type PredictionOutcome,
  store,
  type TestCase,
  toast,
  uid,
  type Workspace,
  workspaceFromExample,
} from "./store";

// ---------------------------------------------------------------------------
// adapters

let adapters: Record<Language, LanguageAdapter> | null = null;

export function getAdapters(): Record<Language, LanguageAdapter> {
  if (!adapters) {
    const python = new PythonAdapter();
    python.onReady(() => store.set({ runtimeReady: true }));
    adapters = { python, javascript: new JavaScriptAdapter() };
  }
  return adapters;
}

/** For tests: inject fake adapters. */
export function setAdapters(a: Record<Language, LanguageAdapter>): void {
  adapters = a;
}

// ---------------------------------------------------------------------------
// analysis

let analysisTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleAnalysis(delay = 250): void {
  if (analysisTimer) clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => void analyzeNow(), delay);
}

export async function analyzeNow(): Promise<SourceAnalysis> {
  const { ws, analysis, analysisFor } = store.get();
  const key = `${ws.language}\u0000${ws.source}`;
  if (analysis && analysisFor === key) return analysis;
  const result = await getAdapters()[ws.language].analyze(ws.source);
  // Store the result only if it still describes the current source (results can arrive out of order).
  const now = store.get();
  if (`${now.ws.language}\u0000${now.ws.source}` === key && now.analysisFor !== key) store.set({ analysis: result, analysisFor: key });
  return result;
}

// ---------------------------------------------------------------------------
// workspace

export function setSource(source: string): void {
  store.updateWs({ source });
  scheduleAnalysis();
}

export function loadExample(id: string): void {
  const ex = exampleById(id);
  if (!ex) return;
  cancelRun();
  store.set({
    ws: workspaceFromExample(id),
    run: { status: "idle", trace: null, version: 0, outcome: null, request: null, testId: null, sourceAtRun: "", phase: "" },
    results: {},
    cursor: 0,
    editing: true,
    overrides: {},
    pointerOverrides: {},
    historyVar: null,
    dialog: null,
    analysis: null,
    analysisFor: "",
    mobileTab: "code",
  });
  scheduleAnalysis(0);
}

export function loadWorkspace(ws: Workspace): void {
  cancelRun();
  store.set({
    ws,
    run: { status: "idle", trace: null, version: 0, outcome: null, request: null, testId: null, sourceAtRun: "", phase: "" },
    results: {},
    cursor: 0,
    editing: true,
    analysis: null,
    analysisFor: "",
    overrides: {},
    pointerOverrides: {},
    historyVar: null,
    dialog: null,
  });
  scheduleAnalysis(0);
}

export function newSolution(language: Language): void {
  const source =
    language === "python"
      ? "class Solution:\n    def solve(self, nums):\n        # write your code here\n        pass\n"
      : "function solve(nums) {\n  // write your code here\n}\n";
  const t = newTest("Case 1", ["[1, 2, 3]"]);
  loadWorkspace({
    id: uid(),
    title: "Untitled",
    language,
    source,
    mode: "function",
    entry: "",
    tests: [t],
    activeTestId: t.id,
    breakpoints: [],
    fragment: { initialState: "{}", setup: "", startLine: 1, endLine: 1 },
    updatedAt: Date.now(),
  });
}

export function setLanguage(language: Language): void {
  if (store.get().ws.language === language) return;
  newSolution(language);
}

export function updateTest(id: string, patch: Partial<TestCase>): void {
  store.updateWs((w) => ({ tests: w.tests.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function addTest(): void {
  const s = store.get();
  const base = activeTest(s);
  const t = newTest(`Case ${s.ws.tests.length + 1}`, [...base.args], { conversions: [...base.conversions] });
  store.updateWs((w) => ({ tests: [...w.tests, t], activeTestId: t.id }));
}

export function removeTest(id: string): void {
  store.updateWs((w) => {
    if (w.tests.length <= 1) return {};
    const tests = w.tests.filter((t) => t.id !== id);
    return { tests, activeTestId: w.activeTestId === id ? (tests[0] as TestCase).id : w.activeTestId };
  });
  store.set((s) => {
    const results = { ...s.results };
    delete results[id];
    return { results };
  });
}

/** Switches the active test case; shows its recorded trace if one exists. */
export function selectTest(id: string): void {
  store.updateWs({ activeTestId: id });
  const r = store.get().results[id];
  if (r) {
    store.set((s) => ({
      run: { ...s.run, status: "done", trace: r.trace, outcome: r.outcome, request: r.request, testId: id, sourceAtRun: r.sourceAtRun, version: s.run.version + 1 },
      cursor: nav.initialFocus(r.trace),
      selectedFrameId: null,
      playing: false,
    }));
  }
}

export function toggleBreakpoint(line: number): void {
  store.updateWs((w) => ({
    breakpoints: w.breakpoints.includes(line) ? w.breakpoints.filter((l) => l !== line) : [...w.breakpoints, line].sort((a, b) => a - b),
  }));
}

export function setBreakpoints(lines: number[]): void {
  store.updateWs({ breakpoints: [...new Set(lines)].sort((a, b) => a - b) });
}

// ---------------------------------------------------------------------------
// running

let current: RunHandle | null = null;
let bumpScheduled = false;

function bumpVersion(): void {
  if (bumpScheduled) return;
  bumpScheduled = true;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16);
  raf(() => {
    bumpScheduled = false;
    store.set((s) => ({ run: { ...s.run, version: s.run.version + 1 } }));
  });
}

export function entryFunction(analysis: SourceAnalysis | null, entry: string): FunctionInfo | undefined {
  return analysis?.functions.find((f) => f.qualname === entry);
}

export function resolvedEntry(analysisOverride?: SourceAnalysis): string {
  const { ws } = store.get();
  const analysis = analysisOverride ?? store.get().analysis;
  if (ws.entry && analysis?.entryCandidates.includes(ws.entry)) return ws.entry;
  return analysis?.entryCandidates[0] ?? ws.entry;
}

/** Decides how each JSON argument is converted. `auto` uses type annotations, then conventional parameter names. */
export function autoConversion(fn: FunctionInfo | undefined, i: number, language: Language): { conv: ArgConversion; reason: string } {
  const p = fn?.params[i];
  if (!p) return { conv: "raw", reason: "" };
  const ann = p.annotation ?? "";
  if (/ListNode/.test(ann)) return { conv: "linked-list", reason: `annotation ${ann}` };
  if (/TreeNode/.test(ann)) return { conv: "binary-tree", reason: `annotation ${ann}` };
  if (ann) return { conv: "raw", reason: "" };
  if (language === "javascript" || !ann) {
    if (/^(head|l1|l2|list1|list2|headA|headB)$/.test(p.name)) return { conv: "linked-list", reason: `parameter named "${p.name}"` };
    if (/^(root|root1|root2|tree)$/.test(p.name)) return { conv: "binary-tree", reason: `parameter named "${p.name}"` };
  }
  return { conv: "raw", reason: "" };
}

export function effectiveConversion(test: TestCase, fn: FunctionInfo | undefined, i: number, language: Language): ArgConversion {
  const c = test.conversions[i] ?? "auto";
  return c === "auto" ? autoConversion(fn, i, language).conv : c;
}

export function cancelRun(): void {
  if (current) {
    current.cancel();
    current = null;
  }
  stopPlayback();
}

export async function run(testId?: string): Promise<void> {
  cancelRun();
  const pre = store.get();
  const tid = testId ?? pre.ws.activeTestId;
  if (testId && testId !== pre.ws.activeTestId) store.updateWs({ activeTestId: testId });
  const analysis = await analyzeNow();
  const s = store.get();
  const ws = s.ws;
  const test = ws.tests.find((t) => t.id === tid) ?? activeTest(s);
  if (!analysis.ok && analysis.diagnostics.some((d) => d.kind === "SyntaxError" || d.severity === "error")) {
    const d = analysis.diagnostics[0];
    store.set({ editing: true });
    toast(d ? `Syntax error on line ${d.line}: ${d.message}` : "Syntax error", "error");
    return;
  }
  const request: ExecutionRequest = { language: ws.language, source: ws.source, mode: ws.mode, limits: s.prefs.limits };
  if (ws.mode === "function") {
    const entry = resolvedEntry(analysis);
    if (!entry) {
      toast("No function or Solution method found. Switch to Script mode to run top-level code.", "error");
      return;
    }
    const fn = entryFunction(analysis, entry);
    const nParams = fn?.params.length ?? test.args.length;
    const args = Array.from({ length: nParams }, (_, i) => test.args[i] ?? "");
    const missing = args.findIndex((a) => !a.trim());
    if (missing >= 0) {
      toast(`Provide a JSON value for parameter "${fn?.params[missing]?.name ?? missing + 1}".`, "error");
      return;
    }
    for (let i = 0; i < args.length; i++) {
      try {
        JSON.parse(args[i] as string);
      } catch {
        toast(`Parameter "${fn?.params[i]?.name ?? i + 1}" is not valid JSON.`, "error");
        return;
      }
    }
    request.entry = entry;
    request.args = args;
    request.argConversions = args.map((_, i) => effectiveConversion(test, fn, i, ws.language));
  } else if (ws.mode === "script") {
    request.stdin = test.stdin;
  } else {
    const lines = ws.source.split("\n");
    const start = Math.max(1, Math.min(ws.fragment.startLine, lines.length));
    const end = Math.max(start, Math.min(ws.fragment.endLine || lines.length, lines.length));
    request.source = lines.slice(start - 1, end).join("\n");
    request.fragment = { initialState: ws.fragment.initialState, setup: ws.fragment.setup, startLine: start };
  }

  const trace = new Trace({ language: ws.language, mode: ws.mode, source: ws.source, ...(request.entry ? { entry: request.entry } : {}) });
  store.set((st) => ({
    run: { status: "starting", trace, version: st.run.version + 1, outcome: null, request, testId: test.id, sourceAtRun: ws.source, phase: "Starting runtime…" },
    cursor: 0,
    selectedFrameId: null,
    playing: false,
    editing: false,
    historyVar: null,
    navNote: null,
    prediction: { ...st.prediction, from: null, fields: [], outcome: null },
    mobileTab: st.mobileTab === "code" ? "viz" : st.mobileTab,
  }));
  const handle = getAdapters()[ws.language].run(request, {
    onEvents: (evs) => {
      trace.append(evs);
      bumpVersion();
    },
    onPhase: (phase) =>
      store.set((st) => (st.run.trace === trace ? { run: { ...st.run, status: phase === "starting" ? "starting" : "running", phase: phase === "starting" ? "Starting runtime…" : "Recording trace…" } } : {})),
  });
  current = handle;
  const outcome = await handle.done;
  if (current === handle) current = null;
  if (store.get().run.trace !== trace) return; // superseded by another run
  if (outcome.terminated) trace.appendSyntheticLimit(outcome.terminated.kind, outcome.terminated.message, outcome.terminated.limit);
  trace.summary = outcome.summary;
  const syntax = outcome.summary.status === "syntax-error";
  store.set((st) => ({
    run: { ...st.run, status: "done", outcome, version: st.run.version + 1, phase: "" },
    cursor: nav.initialFocus(trace),
    editing: syntax || trace.length === 0,
    results: { ...st.results, [test.id]: { testId: test.id, trace, outcome, request, sourceAtRun: ws.source } },
    prediction: st.prediction.enabled ? { ...st.prediction, from: nav.initialFocus(trace), fields: [], outcome: null } : st.prediction,
  }));
  if (syntax) {
    const d = outcome.summary.diagnostics[0];
    toast(d ? `${d.kind} on line ${d.line}: ${d.message}` : "Syntax error", "error");
  } else if (outcome.summary.status === "internal-error") {
    toast(outcome.summary.diagnostics[0]?.message ?? "The harness could not run this code.", "error");
  }
}

export async function runAllTests(): Promise<void> {
  const ids = store.get().ws.tests.map((t) => t.id);
  const active = store.get().ws.activeTestId;
  for (const id of ids) await run(id);
  selectTest(active);
}

// ---------------------------------------------------------------------------
// navigation

function trace(): Trace | null {
  return store.get().run.trace;
}

function predictionPending(): boolean {
  const p = store.get().prediction;
  return p.enabled && p.from !== null && !p.outcome;
}

export function goto(i: number, note: string | null = null): void {
  const t = trace();
  if (!t || t.length === 0) return;
  let idx = Math.max(0, Math.min(t.length - 1, i));
  const p = store.get().prediction;
  if (predictionPending() && p.from !== null && idx > p.from) {
    idx = p.from;
    note = "Submit or skip your prediction to move forward.";
  }
  const pred = store.get().prediction;
  if (pred.enabled && !pred.outcome && pred.from !== idx) {
    store.set({ cursor: idx, selectedFrameId: null, navNote: note, prediction: { ...pred, from: idx, fields: [] } });
    return;
  }
  store.set({ cursor: idx, selectedFrameId: null, navNote: note });
}

function navWith(fn: (t: Trace, i: number) => nav.NavResult, missNote?: string): void {
  const t = trace();
  if (!t) return;
  const r = fn(t, store.get().cursor);
  goto(r.index, r.found ? null : missNote ?? null);
}

export const stepInto = (): void => navWith(nav.stepInto, "End of the recorded trace.");
export const stepBack = (): void => navWith(nav.stepBack, "Start of the trace.");
export const stepOver = (): void => navWith(nav.stepOver, "No later event at this depth — moved to the end.");
export const stepOut = (): void => navWith(nav.stepOut, "No caller frame after this point — moved to the end.");
export const stepBackOver = (): void => navWith(nav.stepBackOver, "Start of the trace.");
export const toStart = (): void => goto(0);
export const toEnd = (): void => {
  const t = trace();
  if (t) goto(t.length - 1);
};

export function nextBreakpoint(): void {
  const s = store.get();
  const t = s.run.trace;
  if (!t) return;
  if (!s.ws.breakpoints.length) {
    store.set({ navNote: "No breakpoints set. Click a line number in the editor to add one." });
    return;
  }
  const r = nav.nextBreakpoint(t, s.cursor, new Set(s.ws.breakpoints));
  goto(r.index, r.found ? null : "No later breakpoint hit — moved to the end of the trace.");
}

export function prevBreakpoint(): void {
  const s = store.get();
  const t = s.run.trace;
  if (!t) return;
  const r = nav.prevBreakpoint(t, s.cursor, new Set(s.ws.breakpoints));
  goto(r.index, r.found ? null : "No earlier breakpoint hit — moved to the start.");
}

// ---------------------------------------------------------------------------
// playback (decoupled from recording: it only moves the cursor)

let playTimer: ReturnType<typeof setTimeout> | undefined;

export function stopPlayback(): void {
  if (playTimer) clearTimeout(playTimer);
  playTimer = undefined;
  if (store.get().playing) store.set({ playing: false });
}

export function togglePlay(): void {
  if (store.get().playing) {
    stopPlayback();
    return;
  }
  const t = trace();
  if (!t || t.length === 0) return;
  if (predictionPending()) {
    store.set({ navNote: "Playback is paused while a prediction is pending." });
    return;
  }
  if (store.get().cursor >= t.length - 1) goto(0);
  store.set({ playing: true, navNote: null });
  const tick = (): void => {
    const s = store.get();
    const tr = s.run.trace;
    if (!s.playing || !tr) return;
    if (s.cursor >= tr.length - 1) {
      stopPlayback();
      return;
    }
    const nextIdx = s.cursor + 1;
    goto(nextIdx);
    const ev = tr.events[nextIdx];
    if (ev && ev.type === "line" && s.ws.breakpoints.includes(ev.loc.line)) {
      stopPlayback();
      store.set({ navNote: `Paused at breakpoint on line ${ev.loc.line}.` });
      return;
    }
    playTimer = setTimeout(tick, 1000 / s.speed);
  };
  playTimer = setTimeout(tick, 1000 / store.get().speed);
}

export function setSpeed(speed: number): void {
  store.set({ speed });
}

// ---------------------------------------------------------------------------
// prediction mode

export function setPredictionEnabled(enabled: boolean): void {
  stopPlayback();
  store.set((s) => ({ prediction: { ...s.prediction, enabled, from: enabled ? s.cursor : null, fields: [], outcome: null }, navNote: null }));
}

/** Where a prediction made at `from` is checked: the next event at the same or a shallower depth. */
export function predictionTarget(t: Trace, from: number): number {
  return nav.stepOver(t, from).index;
}

/** Accepts Python- or JS-style literals and returns plain JSON-comparable data, or undefined if unparsable. */
export function parseGuess(text: string): { ok: true; value: unknown } | { ok: false } {
  const s = text.trim();
  if (!s) return { ok: false };
  const normalized = s
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/\bundefined\b/g, "null")
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/\(([^()]*)\)/g, "[$1]")
    .replace(/,\s*([\]}])/g, "$1");
  try {
    return { ok: true, value: JSON.parse(normalized) };
  } catch {
    return { ok: true, value: s.replace(/^["']|["']$/g, "") };
  }
}

function plainEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => plainEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => plainEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b || String(a) === String(b);
}

export function setPredictionFields(fields: PredictionField[]): void {
  store.set((s) => ({ prediction: { ...s.prediction, fields } }));
}

function valueText(v: Value | undefined, ev: TraceEvent, lang: Language): string {
  return v === undefined ? "—" : formatValue(v, ev.heap, lang, { maxLength: 200, maxDepth: 4 });
}

export function scorePrediction(t: Trace, from: number, fields: PredictionField[], lang: Language): PredictionOutcome {
  const toIdx = predictionTarget(t, from);
  const target = t.events[toIdx] as TraceEvent;
  const out: PredictionOutcome["fields"] = [];
  for (const f of fields) {
    if (f.kind === "line") {
      const actual = isTerminal(target) ? "(program ended)" : String(target.loc.line);
      const g = f.guess.trim();
      out.push({
        key: f.key,
        label: f.label,
        guess: g || "—",
        actual: target.type === "return" ? `${actual} (return)` : actual,
        correct: g ? g === String(target.loc.line) && !isTerminal(target) : null,
      });
    } else if (f.kind === "variable") {
      const frame = target.stack.find((fr) => fr.id === f.frameId);
      const v = frame?.locals.find(([k]) => k === f.name)?.[1] ?? target.globals.find(([k]) => k === f.name)?.[1];
      const actualText = frame || v ? valueText(v, target, lang) : "(frame no longer active)";
      const guess = parseGuess(f.guess);
      let correct: boolean | null = null;
      let note: string | undefined;
      if (guess.ok) {
        if (v === undefined) correct = /^(undefined|none|null|-|—)$/i.test(f.guess.trim());
        else {
          const actualPlain = toPlain(v, target.heap);
          correct = plainEqual(guess.value, actualPlain);
          if (!correct && Array.isArray(guess.value) && Array.isArray(actualPlain)) {
            const g = guess.value;
            const diffs = actualPlain.map((x, i) => (plainEqual(x, g[i]) ? null : i)).filter((x) => x !== null);
            note =
              g.length !== actualPlain.length
                ? `length ${g.length} vs actual ${actualPlain.length}`
                : `differs at index ${diffs.slice(0, 5).join(", ")}${diffs.length > 5 ? "…" : ""}`;
          }
        }
      }
      out.push({ key: f.key, label: f.label, guess: f.guess.trim() || "—", actual: actualText, correct, ...(note ? { note } : {}) });
    } else {
      const fromEv = t.events[from] as TraceEvent;
      const frameId = fromEv.stack[fromEv.stack.length - 1]?.id;
      const returns = target.type === "return" && target.stack[target.stack.length - 1]?.id === frameId && !target.unwind;
      const actual = returns ? valueText(target.returnValue, target, lang) : "(no return at this step)";
      const g = f.guess.trim();
      let correct: boolean | null = null;
      if (g) {
        if (!returns) correct = /^(no|-|—|none returned)$/i.test(g);
        else {
          const guess = parseGuess(g);
          correct = guess.ok && plainEqual(guess.value, toPlain(target.returnValue as Value, target.heap));
        }
      }
      out.push({ key: f.key, label: f.label, guess: g || "—", actual, correct });
    }
  }
  const scored = out.filter((f) => f.correct !== null);
  const right = scored.filter((f) => f.correct).length;
  const verdict: PredictionOutcome["verdict"] = scored.length && right === scored.length ? "correct" : right > 0 ? "partial" : "incorrect";
  return { fields: out, verdict, from, to: toIdx };
}

export function submitPrediction(): void {
  const s = store.get();
  const t = s.run.trace;
  const from = s.prediction.from;
  if (!t || from === null) return;
  if (!s.prediction.fields.some((f) => f.guess.trim())) {
    store.set({ navNote: "Enter at least one prediction before submitting." });
    return;
  }
  const outcome = scorePrediction(t, from, s.prediction.fields, s.ws.language);
  const score = { ...s.prediction.score };
  score[outcome.verdict] += 1;
  store.set({ prediction: { ...s.prediction, outcome, score }, cursor: outcome.to, selectedFrameId: null, navNote: null });
}

export function retryPrediction(): void {
  const s = store.get();
  if (s.prediction.from === null) return;
  store.set({ prediction: { ...s.prediction, outcome: null }, cursor: s.prediction.from });
}

export function continuePrediction(): void {
  const s = store.get();
  store.set({ prediction: { ...s.prediction, from: s.cursor, fields: [], outcome: null } });
}

export function skipPrediction(): void {
  const s = store.get();
  const t = s.run.trace;
  if (!t || s.prediction.from === null) return;
  const to = predictionTarget(t, s.prediction.from);
  store.set({ prediction: { ...s.prediction, from: to, outcome: null, fields: [] }, cursor: to });
}
