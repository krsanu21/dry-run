import { useEffect, useMemo, useRef, useState } from "react";
import type { Trace } from "../trace/store";
import {
  cancelRun,
  goto,
  nextBreakpoint,
  prevBreakpoint,
  run,
  setSpeed,
  stepBack,
  stepBackOver,
  stepInto,
  stepOut,
  stepOver,
  toEnd,
  togglePlay,
  toStart,
} from "./actions";
import { useApp } from "./store";

const SPEEDS = [1, 2, 4, 8, 16, 32, 64];

interface Bucket {
  call: number;
  ret: number;
  exc: number;
  out: number;
  bp: number;
}

/** Timeline markers aggregated per horizontal bucket (O(events) once per trace version, not per render). */
function buildBuckets(trace: Trace, n: number, breakpoints: ReadonlySet<number>, upTo: number): Bucket[] {
  const buckets: Bucket[] = Array.from({ length: n }, () => ({ call: 0, ret: 0, exc: 0, out: 0, bp: 0 }));
  const len = trace.length;
  if (!len) return buckets;
  const at = (i: number): Bucket => buckets[Math.min(n - 1, Math.floor((i / Math.max(1, len - 1)) * (n - 1)))] as Bucket;
  for (const i of trace.callIndices) if (i <= upTo) at(i).call++;
  for (const i of trace.returnIndices) if (i <= upTo) at(i).ret++;
  for (const i of trace.exceptionIndices) if (i <= upTo) at(i).exc++;
  for (const i of trace.stdoutIndices) if (i <= upTo) at(i).out++;
  for (const line of breakpoints) for (const i of trace.lineIndex.get(line) ?? []) if (i <= upTo) at(i).bp++;
  return buckets;
}

export function TraceBar(): React.JSX.Element {
  const trace = useApp((s) => s.run.trace);
  const version = useApp((s) => s.run.version);
  const status = useApp((s) => s.run.status);
  const cursor = useApp((s) => s.cursor);
  const playing = useApp((s) => s.playing);
  const speed = useApp((s) => s.speed);
  const bps = useApp((s) => s.ws.breakpoints);
  const navNote = useApp((s) => s.navNote);
  const predFrom = useApp((s) => (s.prediction.enabled && !s.prediction.outcome ? s.prediction.from : null));
  const hasTrace = !!trace && trace.length > 0;
  const len = trace?.length ?? 0;
  const ev = trace?.events[Math.min(cursor, len - 1)];
  const recording = status === "running" || status === "starting";

  const markerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = markerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(Math.max(100, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const nBuckets = Math.max(20, Math.floor(width / 3));
  const bpSet = useMemo(() => new Set(bps), [bps]);
  const buckets = useMemo(
    () => (trace ? buildBuckets(trace, nBuckets, bpSet, predFrom ?? Infinity) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trace, version, nBuckets, bpSet, predFrom],
  );
  const pct = len > 1 ? (Math.min(cursor, len - 1) / (len - 1)) * 100 : 0;

  return (
    <div className="tracebar" role="toolbar" aria-label="Trace navigation">
      <div className="controls">
        <button type="button" className="icon-btn" onClick={toStart} disabled={!hasTrace} title="Jump to start (Home)" aria-label="Jump to start">
          ⏮
        </button>
        <button type="button" className="icon-btn" onClick={stepBackOver} disabled={!hasTrace} title="Step back over calls (↑)" aria-label="Step back over">
          ⤺
        </button>
        <button type="button" className="icon-btn" onClick={stepBack} disabled={!hasTrace} title="Back one event (←)" aria-label="Back one event">
          ◀
        </button>
        <button type="button" className={`icon-btn play${playing ? " is-on" : ""}`} onClick={togglePlay} disabled={!hasTrace} title="Play / pause (Space)" aria-label={playing ? "Pause" : "Play"} data-testid="play">
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" className="icon-btn" onClick={stepInto} disabled={!hasTrace} title="Step into — next event (→)" aria-label="Step into" data-testid="step-into">
          ▶|
        </button>
        <button type="button" className="icon-btn" onClick={stepOver} disabled={!hasTrace} title="Step over — next event in this frame (↓)" aria-label="Step over" data-testid="step-over">
          ⤼
        </button>
        <button type="button" className="icon-btn" onClick={stepOut} disabled={!hasTrace} title="Step out — return to caller (Shift+↓)" aria-label="Step out" data-testid="step-out">
          ⤴
        </button>
        <button type="button" className="icon-btn" onClick={prevBreakpoint} disabled={!hasTrace} title="Previous breakpoint (Shift+N)" aria-label="Previous breakpoint">
          ◂●
        </button>
        <button type="button" className="icon-btn" onClick={nextBreakpoint} disabled={!hasTrace} title="Run to next breakpoint (N)" aria-label="Run to next breakpoint" data-testid="next-bp">
          ●▸
        </button>
        <button type="button" className="icon-btn" onClick={toEnd} disabled={!hasTrace} title="Jump to end (End)" aria-label="Jump to end">
          ⏭
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => (recording ? cancelRun() : void run())}
          title={recording ? "Stop execution" : "Restart: re-run with the current code and test (R)"}
          aria-label={recording ? "Stop execution" : "Restart"}
        >
          {recording ? "■" : "↻"}
        </button>
        <label className="speed">
          <span className="sr-only">Playback speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×/s
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="timeline">
        <div className="tl-markers" ref={markerRef} aria-hidden>
          {buckets.map((b, i) =>
            b.call || b.ret || b.exc || b.out || b.bp ? (
              <span key={i} className="tl-bucket" style={{ left: `${(i / Math.max(1, buckets.length - 1)) * 100}%` }}>
                {b.bp > 0 && <i className="m-bp" />}
                {b.exc > 0 && <i className="m-exc" />}
                {b.call > 0 && <i className="m-call" />}
                {b.ret > 0 && <i className="m-ret" />}
                {b.out > 0 && <i className="m-out" />}
              </span>
            ) : null,
          )}
          {predFrom !== null && len > 1 && <span className="tl-hidden" style={{ left: `${(predFrom / (len - 1)) * 100}%` }} title="Hidden until you submit your prediction" />}
        </div>
        <input
          type="range"
          className="scrubber"
          min={0}
          max={Math.max(0, len - 1)}
          value={Math.min(cursor, Math.max(0, len - 1))}
          onChange={(e) => goto(Number(e.target.value))}
          disabled={!hasTrace}
          aria-label="Trace position"
          aria-valuetext={ev ? `Step ${cursor} of ${len - 1}, ${ev.type} at line ${ev.loc.line}` : "No trace"}
          style={{ ["--pct" as string]: `${pct}%` }}
          data-testid="scrubber"
        />
      </div>
      <div className="tl-status" data-testid="step-counter">
        {hasTrace ? (
          <>
            <span className="step-num">
              step {Math.min(cursor, len - 1)} / {len - 1}
            </span>
            <span className={`ev-tag ev-${ev?.type}`}>{ev?.type === "line" ? `line ${ev.loc.line} · next` : `${ev?.type} · line ${ev?.loc.line}`}</span>
            {recording && <span className="rec">● recording {len}</span>}
            {!recording && trace && !trace.finished && <span className="warn">trace incomplete</span>}
          </>
        ) : recording ? (
          <span className="rec">● starting…</span>
        ) : (
          <span className="dim">no trace</span>
        )}
        {navNote && (
          <span className="nav-note" role="status">
            {navNote}
          </span>
        )}
        <span className="tl-legend dim">
          <i className="m-call" /> call <i className="m-ret" /> return <i className="m-exc" /> exception <i className="m-bp" /> breakpoint hit <i className="m-out" /> output
        </span>
      </div>
    </div>
  );
}
