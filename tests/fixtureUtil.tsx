import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceAnalysis } from "../src/analysis/types";
import type { Language, TraceEvent, WireEvent } from "../src/trace/schema";
import { Trace } from "../src/trace/store";
import { store } from "../src/ui/store";

export interface Fixture {
  name: string;
  language: Language;
  mode: string;
  source: string;
  entry?: string;
  analysis: SourceAnalysis;
  wire: WireEvent[];
}

export function loadFixture(name: string): { fx: Fixture; trace: Trace } {
  const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8")) as Fixture;
  const trace = new Trace({ language: fx.language, mode: fx.mode, source: fx.source, ...(fx.entry ? { entry: fx.entry } : {}) });
  trace.append(fx.wire);
  return { fx, trace };
}

export function findIndex(trace: Trace, pred: (e: TraceEvent) => boolean, nth = 0): number {
  let seen = 0;
  for (const e of trace.events) {
    if (pred(e)) {
      if (seen === nth) return e.index;
      seen++;
    }
  }
  throw new Error("no matching event");
}

/** Puts a recorded trace into the app store at a given event (no execution involved). */
export function showFixtureAt(name: string, pick: (t: Trace) => number): { trace: Trace; index: number; fx: Fixture } {
  const { fx, trace } = loadFixture(name);
  const index = pick(trace);
  store.reset();
  store.set((s) => ({
    ws: { ...s.ws, language: fx.language, source: fx.source },
    analysis: fx.analysis,
    analysisFor: `${fx.language}\u0000${fx.source}`,
    run: { status: "done", trace, version: 1, outcome: null, request: null, testId: null, sourceAtRun: fx.source, phase: "" },
    cursor: index,
  }));
  return { trace, index, fx };
}
