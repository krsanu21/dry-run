import { useSyncExternalStore } from "react";
import type { SourceAnalysis } from "../analysis/types";
import type { RunOutcome } from "../adapters/types";
import { exampleById } from "../examples";
import { DEFAULT_LIMITS, type ArgConversion, type ExecutionRequest, type Language, type TraceLimits } from "../trace/schema";
import type { PeekHighlight } from "../trace/peek";
import type { Trace } from "../trace/store";
import type { VizKind } from "../viz/model";

export interface TestCase {
  id: string;
  /** one value per parameter, as typed (JSON or a Python / JS literal) */
  args: string[];
  expected: string;
}

/** `Workspace.target` value that runs the whole file instead of calling a function. */
export const WHOLE_FILE = "<file>";

export interface Workspace {
  id: string;
  title: string;
  language: Language;
  source: string;
  /** what Run runs: "" = decided from the code, WHOLE_FILE, or a function's qualname */
  target: string;
  tests: TestCase[];
  activeTestId: string;
  /** how each argument is built before the call (linked list / tree), by parameter position */
  conversions: ArgConversion[];
  /** text read by input() when the whole file runs */
  stdin: string;
  breakpoints: number[];
  exampleId?: string;
  /** signature (`qualname(param, …)`) of the entry point the test cases were written for */
  testsFor?: string;
  updatedAt: number;
}

export interface TestResult {
  testId: string;
  trace: Trace;
  outcome: RunOutcome | null;
  request: ExecutionRequest;
  sourceAtRun: string;
}

export type RunStatus = "idle" | "starting" | "running" | "done";

export interface PredictionField {
  key: string;
  label: string;
  kind: "line" | "variable" | "return";
  frameId?: string;
  name?: string;
  guess: string;
}

export interface PredictionOutcome {
  fields: Array<{ key: string; label: string; guess: string; actual: string; correct: boolean | null; note?: string }>;
  verdict: "correct" | "partial" | "incorrect";
  from: number;
  to: number;
}

export interface PredictionState {
  enabled: boolean;
  /** event index the prediction is made from */
  from: number | null;
  fields: PredictionField[];
  outcome: PredictionOutcome | null;
  score: { correct: number; partial: number; incorrect: number };
}

export interface Prefs {
  theme: "system" | "dark" | "light";
  motion: "system" | "reduced" | "full";
  limits: TraceLimits;
  leftWidth: number;
  rightWidth: number;
  /** the one-time explanation of the change colours was dismissed */
  legendSeen: boolean;
}

export type MobileTab = "code" | "viz" | "vars" | "stack";

export interface AppState {
  ws: Workspace;
  analysis: SourceAnalysis | null;
  analysisFor: string;
  run: {
    status: RunStatus;
    trace: Trace | null;
    version: number;
    outcome: RunOutcome | null;
    request: ExecutionRequest | null;
    testId: string | null;
    sourceAtRun: string;
    phase: string;
  };
  results: Record<string, TestResult>;
  cursor: number;
  selectedFrameId: string | null;
  playing: boolean;
  speed: number;
  watches: string[];
  overrides: Record<string, VizKind>;
  pointerOverrides: Record<string, { add: string[]; hide: string[] }>;
  prediction: PredictionState;
  mobileTab: MobileTab;
  dialog: null | "shortcuts" | "settings" | "share" | "library" | "examples";
  toast: { text: string; kind: "info" | "error"; action?: { label: string; run(): void } } | null;
  sharedPending: Partial<Workspace> | null;
  prefs: Prefs;
  runtimeReady: boolean;
  navNote: string | null;
  /** incremented to ask the editor to scroll to and highlight the first error */
  revealError: number;
  /** what the Trace Peek tooltip is showing, so the visualizers can mark it */
  peek: PeekHighlight | null;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newTest(args: string[] = [], expected = ""): TestCase {
  return { id: uid(), args, expected };
}

export function workspaceFromExample(id: string): Workspace {
  const ex = exampleById(id);
  if (!ex) throw new Error(`unknown example ${id}`);
  const tests = ex.tests.length ? ex.tests.map((t) => newTest([...t.args], t.expected ?? "")) : [newTest()];
  return {
    id: uid(),
    title: ex.title,
    language: ex.language,
    source: ex.source,
    target: "",
    tests,
    activeTestId: (tests[0] as TestCase).id,
    conversions: [...(ex.conversions ?? [])],
    stdin: "",
    breakpoints: [],
    exampleId: ex.id,
    updatedAt: Date.now(),
  };
}

/**
 * Accepts any stored workspace shape — the current one, or the older one with a run `mode`,
 * an `entry`, named test cases and per-case conversions / stdin — and returns a current one.
 */
export function normalizeWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.source !== "string" || !Array.isArray(w.tests)) return null;
  const oldTests = w.tests.filter((t): t is Record<string, unknown> => !!t && typeof t === "object");
  const tests = oldTests.map((t) => ({
    id: typeof t.id === "string" ? t.id : uid(),
    args: Array.isArray(t.args) ? t.args.map(String) : [],
    expected: typeof t.expected === "string" ? t.expected : "",
  }));
  if (!tests.length) tests.push(newTest());
  const first = oldTests[0] ?? {};
  const target =
    typeof w.target === "string" ? w.target : w.mode === "script" ? WHOLE_FILE : w.mode === "function" && typeof w.entry === "string" ? w.entry : "";
  const conv = (Array.isArray(w.conversions) ? w.conversions : Array.isArray(first.conversions) ? first.conversions : []).filter((c): c is ArgConversion =>
    ["auto", "raw", "linked-list", "binary-tree"].includes(String(c)),
  );
  const language: Language = w.language === "javascript" ? "javascript" : "python";
  const activeTestId = typeof w.activeTestId === "string" && tests.some((t) => t.id === w.activeTestId) ? w.activeTestId : (tests[0] as TestCase).id;
  return {
    id: typeof w.id === "string" ? w.id : uid(),
    title: typeof w.title === "string" ? w.title : "Untitled",
    language,
    source: w.source,
    target,
    tests,
    activeTestId,
    conversions: conv,
    stdin: typeof w.stdin === "string" ? w.stdin : typeof first.stdin === "string" ? first.stdin : "",
    breakpoints: Array.isArray(w.breakpoints) ? w.breakpoints.filter((n): n is number => typeof n === "number") : [],
    ...(typeof w.exampleId === "string" ? { exampleId: w.exampleId } : {}),
    ...(typeof w.testsFor === "string" ? { testsFor: w.testsFor } : {}),
    updatedAt: typeof w.updatedAt === "number" ? w.updatedAt : Date.now(),
  };
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  motion: "system",
  limits: { ...DEFAULT_LIMITS },
  leftWidth: 460,
  rightWidth: 340,
  legendSeen: false,
};

function initialState(): AppState {
  return {
    ws: workspaceFromExample("two-sum"),
    analysis: null,
    analysisFor: "",
    run: { status: "idle", trace: null, version: 0, outcome: null, request: null, testId: null, sourceAtRun: "", phase: "" },
    results: {},
    cursor: 0,
    selectedFrameId: null,
    playing: false,
    speed: 4,
    watches: [],
    overrides: {},
    pointerOverrides: {},
    prediction: { enabled: false, from: null, fields: [], outcome: null, score: { correct: 0, partial: 0, incorrect: 0 } },
    mobileTab: "code",
    dialog: null,
    toast: null,
    sharedPending: null,
    prefs: DEFAULT_PREFS,
    runtimeReady: false,
    navNote: null,
    revealError: 0,
    peek: null,
  };
}

type Listener = () => void;

class Store {
  private state: AppState = initialState();
  private readonly listeners = new Set<Listener>();

  get = (): AppState => this.state;

  set = (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void => {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };

  updateWs = (patch: Partial<Workspace> | ((w: Workspace) => Partial<Workspace>)): void => {
    this.set((s) => {
      const p = typeof patch === "function" ? patch(s.ws) : patch;
      return { ws: { ...s.ws, ...p, updatedAt: Date.now() } };
    });
  };

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** test helper */
  reset(next?: Partial<AppState>): void {
    this.state = { ...initialState(), ...(next ?? {}) };
    for (const l of this.listeners) l();
  }
}

export const store = new Store();

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

export function activeTest(s: AppState): TestCase {
  return s.ws.tests.find((t) => t.id === s.ws.activeTestId) ?? (s.ws.tests[0] as TestCase);
}

export function toast(text: string, kind: "info" | "error" = "info", action?: { label: string; run(): void }): void {
  const t = { text, kind, ...(action ? { action } : {}) };
  store.set({ toast: t });
  setTimeout(() => {
    if (store.get().toast === t) store.set({ toast: null });
  }, action ? 6000 : 3500);
}
