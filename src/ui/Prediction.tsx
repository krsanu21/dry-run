import { useEffect } from "react";
import { sourceLine } from "../trace/describe";
import { isTerminal } from "../trace/store";
import { continuePrediction, retryPrediction, setPredictionEnabled, setPredictionFields, skipPrediction, submitPrediction } from "./actions";
import { frameScalars } from "./Inspector";
import { type PredictionField, store, useApp } from "./store";
import { useCurrentStep } from "./useTrace";

/**
 * Prediction mode. The user predicts the state after the current line runs
 * (the next event at the same or shallower call depth). Supported prediction
 * types: next line, values of chosen variables in the current frame, and the
 * return value. Scoring compares against the recorded trace only.
 */
export function PredictionPanel(): React.JSX.Element {
  const step = useCurrentStep();
  const pred = useApp((s) => s.prediction);
  const source = useApp((s) => s.run.sourceAtRun);

  // Initialise fields when a new prediction starts.
  useEffect(() => {
    if (!step || !pred.enabled || pred.from === null || pred.outcome || pred.fields.length) return;
    const ev = step.trace.events[pred.from];
    if (!ev || isTerminal(ev)) return;
    const f = ev.stack[ev.stack.length - 1];
    const fields: PredictionField[] = [{ key: "line", label: "Next line", kind: "line", guess: "" }];
    for (const name of frameScalars(f, ev).slice(0, 6)) fields.push({ key: `v:${name}`, label: name, kind: "variable", frameId: f?.id as string, name, guess: "" });
    if (/\breturn\b/.test(sourceLine(source, ev.loc.line)) || ev.type === "return") fields.push({ key: "ret", label: "Return value", kind: "return", guess: "" });
    setPredictionFields(fields);
  }, [step, pred.enabled, pred.from, pred.outcome, pred.fields.length, source]);

  if (!pred.enabled)
    return (
      <div className="pred-off">
        <p>Hide the next state and guess it before it is revealed.</p>
        <button type="button" className="btn" onClick={() => setPredictionEnabled(true)} disabled={!step} data-testid="pred-enable">
          Start predicting
        </button>
      </div>
    );
  if (!step) return <div className="side-empty">Run your code first.</div>;
  const fromEv = pred.from !== null ? step.trace.events[pred.from] : undefined;
  const score = pred.score;

  return (
    <div className="prediction" data-testid="prediction">
      <div className="pred-head">
        <span>
          Score: <strong className="ok">{score.correct}</strong> correct · <strong className="part">{score.partial}</strong> partial · <strong className="bad">{score.incorrect}</strong> missed
        </span>
        <button type="button" className="mini-btn" onClick={() => setPredictionEnabled(false)}>
          Exit
        </button>
      </div>
      {fromEv && isTerminal(fromEv) && <p className="dim">The trace has ended — nothing left to predict.</p>}
      {fromEv && !isTerminal(fromEv) && !pred.outcome && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitPrediction();
          }}
        >
          <p className="pred-q">
            {fromEv.type === "line" ? (
              <>
                Line <strong>{fromEv.loc.line}</strong> is about to run. What will the state be <em>after</em> it (or when this frame next pauses)?
              </>
            ) : (
              <>What happens next in this frame?</>
            )}
          </p>
          {pred.fields.map((f) => (
            <div className="pred-field" key={f.key}>
              <label htmlFor={`pred-${f.key}`}>{f.kind === "variable" ? <code>{f.label}</code> : f.label}</label>
              <input
                id={`pred-${f.key}`}
                value={f.guess}
                inputMode={f.kind === "line" ? "numeric" : "text"}
                placeholder={f.kind === "line" ? "line number" : f.kind === "return" ? "value, or “no”" : "value (Python or JSON literal)"}
                onChange={(e) => setPredictionFields(pred.fields.map((x) => (x.key === f.key ? { ...x, guess: e.target.value } : x)))}
                data-testid={`pred-input-${f.key}`}
              />
              {f.kind === "variable" && (
                <button type="button" className="mini-btn" aria-label={`Don't predict ${f.label}`} onClick={() => setPredictionFields(pred.fields.filter((x) => x.key !== f.key))}>
                  ×
                </button>
              )}
            </div>
          ))}
          <div className="pred-actions">
            <button type="submit" className="btn primary" data-testid="pred-submit">
              Reveal &amp; score <kbd>Enter</kbd>
            </button>
            <button type="button" className="btn" onClick={skipPrediction}>
              Skip
            </button>
          </div>
          <p className="dim small">Leave a field blank to not score it. Lists can be entered as [1, 2, 3].</p>
        </form>
      )}
      {pred.outcome && (
        <div className={`pred-outcome v-${pred.outcome.verdict}`} data-testid="pred-outcome">
          <div className="pred-verdict">
            {pred.outcome.verdict === "correct" ? "✓ Correct" : pred.outcome.verdict === "partial" ? "◐ Partially correct" : "✕ Not quite"}
            <span className="dim small"> — revealed step {pred.outcome.to}</span>
          </div>
          <table className="pred-table">
            <thead>
              <tr>
                <th />
                <th>You said</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {pred.outcome.fields.map((f) => (
                <tr key={f.key} className={f.correct === null ? "unscored" : f.correct ? "right" : "wrong"}>
                  <td>
                    {f.correct === null ? "–" : f.correct ? "✓" : "✕"} {f.label}
                  </td>
                  <td>
                    <code>{f.guess}</code>
                  </td>
                  <td>
                    <code>{f.actual}</code>
                    {f.note && <div className="dim small">{f.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pred-actions">
            <button type="button" className="btn primary" onClick={continuePrediction} data-testid="pred-continue">
              Next prediction
            </button>
            <button type="button" className="btn" onClick={retryPrediction}>
              Retry this step
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function predictionKeySubmit(): boolean {
  const p = store.get().prediction;
  if (p.enabled && p.from !== null && !p.outcome) {
    submitPrediction();
    return true;
  }
  if (p.enabled && p.outcome) {
    continuePrediction();
    return true;
  }
  return false;
}
