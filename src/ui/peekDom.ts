import type { PeekModel } from "../trace/peek";

/**
 * Builds the Trace Peek tooltip. Plain DOM with `textContent` only: everything shown
 * comes from the traced program (names, strings, attributes), so nothing here is ever
 * interpreted as markup.
 */

export interface PeekActions {
  /** a pinned peek (keyboard / touch) has a close button and stays until dismissed */
  pinned: boolean;
  close(): void;
  goto(step: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

const STATUS_TITLE: Record<PeekModel["status"], string> = {
  value: "",
  "not-yet": "not assigned yet",
  unbound: "not defined here",
  inactive: "not in scope",
  stale: "trace is out of date",
  unresolved: "cannot be resolved",
};

/** The text a screen reader announces when a peek opens. */
export function peekAnnouncement(m: PeekModel): string {
  if (m.status !== "value") return `${m.expr}: ${m.message ?? STATUS_TITLE[m.status]}`;
  const first = m.change ? ` ${m.change.headline}` : "";
  return `${m.expr}, ${m.type ?? ""}${m.length !== undefined ? `, length ${m.length}` : ""}: ${m.summary ?? ""}.${first} ${m.moment}.`;
}

export function renderPeek(m: PeekModel, a: PeekActions): HTMLElement {
  const root = el("div", `peek status-${m.status}`);
  root.dataset.testid = "peek";
  root.dataset.status = m.status;
  root.setAttribute("role", a.pinned ? "dialog" : "tooltip");
  root.setAttribute("aria-label", `Value of ${m.expr}`);

  const head = el("header", "peek-head", undefined, root);
  el("code", "peek-name", m.expr, head).dataset.testid = "peek-name";
  if (m.status === "value") {
    const bits = [m.type, m.length !== undefined ? `len ${m.length}` : undefined].filter(Boolean);
    el("span", "peek-type", bits.join(" · "), head).dataset.testid = "peek-type";
  } else el("span", "peek-status", STATUS_TITLE[m.status], head);
  if (a.pinned) {
    const x = el("button", "peek-close", "×", head);
    x.type = "button";
    x.setAttribute("aria-label", "Close peek");
    x.dataset.testid = "peek-close";
    x.addEventListener("click", (e) => {
      e.preventDefault();
      a.close();
    });
  }

  if (m.scopeLabel) el("div", "peek-scope", m.status === "value" ? `${m.scopeKind === "global" ? "" : "in "}${m.scopeLabel}` : m.scopeLabel, root).dataset.testid = "peek-scope";

  if (m.status !== "value") {
    el("p", "peek-message", m.message ?? "", root).dataset.testid = "peek-message";
    if (m.jump) {
      const jump = m.jump;
      const b = el("button", "peek-jump", jump.label, root);
      b.type = "button";
      b.dataset.testid = "peek-jump";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        a.goto(jump.step);
      });
    }
    el("footer", "peek-moment", m.moment, root);
    return root;
  }

  // value: strings in full, everything else as a one-line summary plus rows
  const val = el("div", "peek-value", m.text !== undefined ? m.text : m.summary, root);
  val.dataset.testid = "peek-value";
  if (m.text !== undefined) val.classList.add("is-string");

  if (m.rows.length) {
    const t = el("table", "peek-rows", undefined, root);
    t.dataset.testid = "peek-rows";
    for (const r of m.rows) {
      const tr = el("tr", r.mark ? `mark-${r.mark}` : "", undefined, t);
      el("th", "", r.key, tr);
      el("td", "", r.value, tr);
      if (r.mark) el("td", "peek-mark", r.mark === "new" ? "+" : "Δ", tr).title = r.mark === "new" ? "new at the previous step" : "changed at the previous step";
    }
    if (m.rowsMore > 0) el("div", "peek-more", `… and ${m.rowsMore} more`, root);
  }

  if (m.change) {
    const c = el("div", `peek-change ch-${m.change.kind}`, undefined, root);
    c.dataset.testid = "peek-change";
    el("span", "peek-change-head", m.change.headline, c);
    if (m.change.was !== undefined) {
      c.append(" ");
      el("span", "peek-was", `was ${m.change.was}`, c);
    }
    if (m.change.details.length) {
      const ul = el("ul", "peek-details", undefined, c);
      for (const d of m.change.details) el("li", "", d, ul);
    }
  }

  if (m.others.length) {
    const o = el("div", "peek-others", undefined, root);
    o.dataset.testid = "peek-others";
    el("span", "peek-label", "In each active call", o);
    for (const x of m.others) {
      const chip = el("span", `peek-chip${x.selected ? " is-selected" : ""}`, `${x.depth}: ${x.value}`, o);
      chip.title = `recursion depth ${x.depth}${x.selected ? " (the call shown)" : ""}`;
    }
  }
  if (m.history.length > 1 || m.mutatedAt.length) {
    const h = el("div", "peek-history", undefined, root);
    h.dataset.testid = "peek-history";
    el("span", "peek-label", "History", h);
    const stepBtn = (step: number, text: string, cls = ""): void => {
      const b = el("button", `peek-step${cls}`, text, h);
      b.type = "button";
      b.title = `Go to step ${step}`;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        a.goto(step);
      });
    };
    m.history.forEach((x, i) => stepBtn(x.step, `${x.value} @${x.step}`, i === m.history.length - 1 ? " is-now" : ""));
    if (m.mutatedAt.length) {
      el("span", "peek-sub", "changed in place at", h);
      for (const step of m.mutatedAt) stepBtn(step, `@${step}`);
    }
  }
  if (m.aliases.length) {
    const al = el("div", "peek-aliases", undefined, root);
    al.dataset.testid = "peek-aliases";
    el("span", "peek-label", "Same object as", al);
    al.append(` ${m.aliases.join(", ")}`);
  }
  if (m.notes.length) {
    const ul = el("ul", "peek-notes", undefined, root);
    ul.dataset.testid = "peek-notes";
    for (const n of m.notes) el("li", "", n, ul);
  }
  el("footer", "peek-moment", `value ${m.moment}`, root);
  return root;
}
