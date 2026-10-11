import { useSyncExternalStore } from "react";
import type { SourceAnalysis } from "../analysis/types";
import type { RunOutcome } from "../adapters/types";
import { exampleById } from "../examples";
import { DEFAULT_LIMITS, type ArgConversion, type ExecutionRequest, type Language, type RunMode, type TraceLimits } from "../trace/schema";
import type { Trace } from "../trace/store";
import type { VizKind } from "../viz/model";

export interface TestCase {
  id: string;
  name: string;
  /** JSON text per parameter */
  args: string[];
  expected: string;
  conversions: ArgConversion[];
  stdin: string;
}

export interface FragmentConfig {
  initialState: string;
  setup: string;
  startLine: number;
  endLine: number;
}

export interface Workspace {
  id: string;
  title: string;
  language: Language;
  source: string;
  mode: RunMode;
  /** chosen entry point; "" = first detected candidate */
  entry: string;
  tests: TestCase[];
  activeTestId: string;
  breakpoints: number[];
  fragment: FragmentConfig;
  exampleId?: string;
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
  heatmap: boolean;
  showFunctions: boolean;
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
  editing: boolean;
  historyVar: { frameId: string; name: string } | null;
  inspectId: string | null;
  watches: string[];
  overrides: Record<string, VizKind>;
  pointerOverrides: Record<string, { add: string[]; hide: string[] }>;
  prediction: PredictionState;
  mobileTab: MobileTab;
  dialog: null | "shortcuts" | "settings" | "share" | "library" | "examples";
  toast: { text: string; kind: "info" | "error" } | null;
  sharedPending: Partial<Workspace> | null;
  prefs: Prefs;
  runtimeReady: boolean;
  navNote: string | null;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newTest(name: string, args: string[] = [], extra: Partial<TestCase> = {}): TestCase {
  return { id: uid(), name, args, expected: "", conversions: [], stdin: "", ...extra };
}

export function workspaceFromExample(id: string): Workspace {
  const ex = exampleById(id);
  if (!ex) throw new Error(`unknown example ${id}`);
  const tests = ex.tests.length
    ? ex.tests.map((t) => newTest(t.name, [...t.args], { expected: t.expected ?? "", conversions: t.conversions ? [...t.conversions] : [], stdin: t.stdin ?? "" }))
    : [newTest("Case 1")];
  return {
    id: uid(),
    title: ex.title,
    language: ex.language,
    source: ex.source,
    mode: ex.mode,
    entry: ex.entry ?? "",
    tests,
    activeTestId: (tests[0] as TestCase).id,
    breakpoints: [],
    fragment: ex.fragment ? { ...ex.fragment } : { initialState: "{}", setup: "", startLine: 1, endLine: 1 },
    exampleId: ex.id,
    updatedAt: Date.now(),
  };
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  motion: "system",
  limits: { ...DEFAULT_LIMITS },
  leftWidth: 460,
  rightWidth: 340,
  heatmap: true,
  showFunctions: false,
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
    editing: true,
    historyVar: null,
    inspectId: null,
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

export function toast(text: string, kind: "info" | "error" = "info"): void {
  store.set({ toast: { text, kind } });
  setTimeout(() => {
    if (store.get().toast?.text === text) store.set({ toast: null });
  }, 3500);
}
