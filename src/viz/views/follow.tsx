import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeping the action in view for structures larger than their panel.
 *
 * After every step, the most relevant cell (written > changed > new > addressed
 * > pointed at > read) is scrolled to the centre of its scroll container — but
 * only when it is not already comfortably visible, so small structures and
 * steps that stay on screen never move.
 */

const FOCUS_ORDER = [".is-write", ".st-changed", ".st-new", ".is-active", ".is-pointed", ".is-read"];
const MARGIN = 24;

export function useFollowFocus(ref: RefObject<HTMLElement | null>, stepKey: number, reducedMotion: boolean): void {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight)) return;
    let target: Element | null = null;
    for (const sel of FOCUS_ORDER) {
      target = box.querySelector(sel);
      if (target) break;
    }
    if (!target) return;
    const b = box.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    // sticky headers cover the top/left edge of a scrolling grid
    const stickTop = (box.querySelector("thead") as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
    const stickLeft = (box.querySelector("tbody th") as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    let left = box.scrollLeft;
    let top = box.scrollTop;
    if (t.left < b.left + stickLeft + MARGIN || t.right > b.right - MARGIN) left += t.left - b.left - stickLeft - (b.width - stickLeft - t.width) / 2;
    if (t.top < b.top + stickTop + MARGIN || t.bottom > b.bottom - MARGIN) top += t.top - b.top - stickTop - (b.height - stickTop - t.height) / 2;
    if (left === box.scrollLeft && top === box.scrollTop) return;
    // glide for short moves; jump for long ones so fast stepping never lags behind
    const far = Math.abs(left - box.scrollLeft) > box.clientWidth || Math.abs(top - box.scrollTop) > box.clientHeight;
    box.scrollTo({ left, top, behavior: reducedMotion || far ? "auto" : "smooth" });
  }, [stepKey]);
}

/** Visible fraction of a scroll container, updated on scroll and resize. */
function useViewport(ref: RefObject<HTMLElement | null>, contentKey: unknown): { x0: number; x1: number; y0: number; y1: number; overflowX: boolean; overflowY: boolean } {
  const [v, setV] = useState({ x0: 0, x1: 1, y0: 0, y1: 1, overflowX: false, overflowY: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.scrollWidth || 1;
    const h = el.scrollHeight || 1;
    const next = {
      x0: el.scrollLeft / w,
      x1: (el.scrollLeft + el.clientWidth) / w,
      y0: el.scrollTop / h,
      y1: (el.scrollTop + el.clientHeight) / h,
      overflowX: el.scrollWidth > el.clientWidth + 1,
      overflowY: el.scrollHeight > el.clientHeight + 1,
    };
    setV((p) => (p.x0 === next.x0 && p.x1 === next.x1 && p.y0 === next.y0 && p.y1 === next.y1 && p.overflowX === next.overflowX && p.overflowY === next.overflowY ? p : next));
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [ref, measure]);
  // content changes (a new step) can change the scroll extent without a resize of the box itself
  useEffect(measure, [measure, contentKey]);
  return v;
}

export type MarkKind = "write" | "changed" | "new" | "pointer" | "active";

/**
 * A thin overview strip under a horizontally scrolling array: where the visible
 * window is, where pointers sit and which cells changed. Click to jump.
 */
export function ArrayOverview({ scrollRef, count, marks, label }: { scrollRef: RefObject<HTMLElement | null>; count: number; marks: Array<{ index: number; kind: MarkKind }>; label: string }): React.JSX.Element | null {
  const vp = useViewport(scrollRef, count);
  if (!vp.overflowX || count < 2) return null;
  const first = Math.max(0, Math.floor(vp.x0 * count));
  const last = Math.min(count - 1, Math.ceil(vp.x1 * count) - 1);
  const jump = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = scrollRef.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    el.scrollTo({ left: f * el.scrollWidth - el.clientWidth / 2, behavior: "smooth" });
  };
  return (
    <div className="overview-1d">
      <div className="ov1-track" onClick={jump} role="presentation" title="Click to jump">
        <div className="ov1-window" style={{ left: `${vp.x0 * 100}%`, width: `${Math.max(1, (vp.x1 - vp.x0) * 100)}%` }} />
        {marks.map((m, k) => (
          <span key={k} className={`ov1-mark mk-${m.kind}`} style={{ left: `${((m.index + 0.5) / count) * 100}%` }} />
        ))}
      </div>
      <span className="ov1-label" aria-live="off">
        {label} {first}–{last} of {count}
      </span>
    </div>
  );
}

/** Minimap for grids larger than their panel; the viewport rectangle can be clicked to jump. */
export function GridMinimap({
  scrollRef,
  rows,
  cols,
  marks,
  stepKey,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  rows: number;
  cols: number;
  marks: Array<{ r: number; c: number; kind: MarkKind }>;
  stepKey: number;
}): React.JSX.Element | null {
  const vp = useViewport(scrollRef, `${rows}x${cols}:${stepKey}`);
  const canvas = useRef<HTMLCanvasElement>(null);
  const show = (vp.overflowX || vp.overflowY) && rows > 0 && cols > 0;
  const cell = Math.max(1, Math.floor(110 / Math.max(rows, cols)));
  const w = cols * cell;
  const h = rows * cell;
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !show) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const css = getComputedStyle(cv);
    const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = color("--bg-3", "#20252d");
    g.fillRect(0, 0, w, h);
    const fill: Record<MarkKind, string> = {
      new: color("--new", "#56b4e9"),
      changed: color("--chg", "#e69f00"),
      write: color("--write", "#ef6a45"),
      pointer: color("--ptr", "#d58bc0"),
      active: color("--ptr", "#d58bc0"),
    };
    for (const m of marks) {
      g.fillStyle = fill[m.kind];
      const pad = m.kind === "active" ? -1 : 0;
      g.fillRect(m.c * cell + pad, m.r * cell + pad, Math.max(1, cell - 2 * pad), Math.max(1, cell - 2 * pad));
    }
  }, [show, marks, w, h, cell, stepKey]);
  if (!show) return null;
  const jump = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = scrollRef.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.scrollTo({ left: ((e.clientX - r.left) / r.width) * el.scrollWidth - el.clientWidth / 2, top: ((e.clientY - r.top) / r.height) * el.scrollHeight - el.clientHeight / 2, behavior: "smooth" });
  };
  return (
    <div className="grid-minimap" style={{ width: w, height: h }} onClick={jump} role="presentation" title="Overview — click to jump">
      <canvas ref={canvas} style={{ width: w, height: h }} aria-hidden="true" />
      <div
        className="gm-window"
        style={{ left: `${vp.x0 * 100}%`, top: `${vp.y0 * 100}%`, width: `${Math.max(2, (vp.x1 - vp.x0) * 100)}%`, height: `${Math.max(2, (vp.y1 - vp.y0) * 100)}%` }}
      />
    </div>
  );
}
