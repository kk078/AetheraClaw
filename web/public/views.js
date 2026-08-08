// ── Tool view renderers ──────────────────────────────────────────────────────
// A tool may return a structured payload alongside its text. This turns those
// payloads into components. Everything here is display: no fetching, no
// decisions. Which severity a finding carries and whether a repair may be
// offered as a button were decided server-side in src/views/build.ts, where they
// are testable — a browser is the wrong place to re-derive a domain judgement,
// and a second implementation would drift from the rule engine.
//
// Every string reaching the DOM goes through textContent, never innerHTML. These
// payloads carry payer names, remittance text and model output; the transcript
// renderer already escapes-then-formats for that reason, and building nodes
// directly means this file has no escaping to get wrong.

const V = {};

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const money = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const svg = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

// ── claim_scrub: the line-item form ──────────────────────────────────────────

V.claim_scrub = (d) => {
  const root = node("div", "toolview view-scrub");

  if (d.verdict) {
    const v = node("div", `verdict verdict-${d.verdict}`);
    v.append(
      node("strong", null, { hold: "HOLD", review: "REVIEW", clear: "CLEAR" }[d.verdict]),
      node("span", null,
        d.verdict === "hold" ? "Do not submit as it stands."
        : d.verdict === "review" ? "A coder should look at this before it goes out."
        : "Nothing that was checked failed."),
    );
    root.append(v);
  }

  // Blind spots go ABOVE the table. A verdict read without knowing what was
  // skipped is a verdict about a different claim.
  if (d.blindSpots?.length) {
    const b = node("div", "blindspots");
    b.append(node("div", "bs-head", `Not checked — ${d.blindSpots.length} check(s) could not run`));
    const ul = node("ul");
    for (const s of d.blindSpots) ul.append(node("li", null, s));
    b.append(ul);
    root.append(b);
  }

  const head = node("div", "scrub-head");
  head.append(
    node("span", "claim-id", d.claimId || "(no claim id)"),
    node("span", "payer", d.payer || ""),
    node("span", "total", money(d.totalCharge)),
  );
  const chips = node("span", "chips");
  for (const sev of ["error", "warning", "info", "clean"]) {
    if (!d.counts?.[sev]) continue;
    chips.append(node("span", `chip chip-${sev}`, `${d.counts[sev]} ${sev}`));
  }
  head.append(chips);
  root.append(head);

  for (const f of d.claimFindings ?? []) root.append(finding(f, "claim-level"));

  const table = node("table", "lines");
  const thead = node("thead");
  const hr = node("tr");
  for (const h of ["#", "Code", "Mods", "Units", "POS", "DOS", "Dx", "Charge"]) hr.append(node("th", null, h));
  thead.append(hr);
  table.append(thead);

  const tbody = node("tbody");
  for (const line of d.lines ?? []) {
    const tr = node("tr", `sev-${line.severity}`);
    tr.append(
      node("td", "num", String(line.index)),
      node("td", "code", line.code),
      node("td", null, (line.modifiers || []).join(" ") || "—"),
      node("td", "num", String(line.units)),
      posCell(line),
      node("td", null, line.serviceDate || "—"),
      node("td", null, (line.dxPointers || []).join(",") || "—"),
      node("td", "num", money(line.charge)),
    );
    tbody.append(tr);

    if (line.findings?.length) {
      const detail = node("tr", "detail-row");
      const td = node("td");
      td.colSpan = 8;
      for (const f of line.findings) td.append(finding(f));
      detail.append(td);
      tbody.append(detail);
    }
  }
  table.append(tbody);
  root.append(table);
  return root;
};

function posCell(line) {
  const td = node("td", "pos");
  td.append(node("span", null, line.pos || "—"));
  // The POS name is the fact a model got wrong from memory; showing it beside
  // the code means nobody has to remember what 22 means.
  if (line.posName) td.append(node("span", "pos-name", line.posName));
  return td;
}

function finding(f, extraClass) {
  const box = node("div", `finding f-${f.severity}${extraClass ? ` ${extraClass}` : ""}`);
  const head = node("div", "f-head");
  head.append(node("span", "f-rule", f.rule), node("span", "f-msg", f.message));
  box.append(head);

  if (f.fix) {
    // A button appears ONLY for a repair that writes down what the claim
    // already said. Anything needing a fact the claim does not contain renders
    // as a question below — a one-click "accept" on a POS/telehealth mismatch
    // would put a false statement on a Medicare claim in a single click.
    const fix = node("div", "f-fix");
    fix.append(
      node("span", "fix-label", "Safe repair"),
      node("code", null, f.fix.from || "(empty)"),
      node("span", "arrow", "→"),
      node("code", null, f.fix.to || "(empty)"),
    );
    box.append(fix);
  }
  if (f.question) {
    const q = node("div", "f-question");
    q.append(node("span", "q-label", "Needs a human"), node("span", null, f.question));
    box.append(q);
  }
  return box;
}

// ── money_waterfall ──────────────────────────────────────────────────────────

V.money_waterfall = (d) => {
  const root = node("div", "toolview view-waterfall");
  root.append(node("div", "view-title", d.title));

  if (d.reclaimable !== null && d.reclaimable !== undefined) {
    const badge = node("div", "badge-money");
    badge.append(node("span", "badge-amt", `+${money(d.reclaimable)}`), node("span", "badge-lbl", d.reclaimableLabel));
    root.append(badge);
  } else {
    root.append(node("div", "badge-none", "Nothing reclaimable found in what was checked."));
  }

  const steps = d.steps || [];
  const magnitudes = steps.map((s) => Math.abs(s.amount));
  const max = Math.max(1, ...magnitudes);
  const W = 520, rowH = 34, pad = 8;
  const chart = svg("svg", {
    viewBox: `0 0 ${W} ${steps.length * rowH + pad * 2}`,
    class: "waterfall",
    role: "img",
    "aria-label": d.title,
  });

  steps.forEach((s, i) => {
    const y = pad + i * rowH;
    const w = Math.max(2, (Math.abs(s.amount) / max) * (W - 210));
    chart.append(svg("rect", {
      x: 150, y: y + 6, width: w, height: 16, rx: 3,
      class: `wf-bar wf-${s.kind}`,
    }));
    const label = svg("text", { x: 142, y: y + 18, class: "wf-label", "text-anchor": "end" });
    label.textContent = s.label;
    const val = svg("text", { x: 150 + w + 8, y: y + 18, class: "wf-val" });
    val.textContent = money(Math.abs(s.amount));
    chart.append(label, val);
  });
  root.append(chart);

  const notes = node("ul", "wf-notes");
  for (const s of steps) if (s.note) notes.append(node("li", null, `${s.label}: ${s.note}`));
  root.append(notes);
  root.append(node("p", "caveat", d.caveat));
  return root;
};

// ── em_meter ─────────────────────────────────────────────────────────────────

V.em_meter = (d) => {
  const root = node("div", `toolview view-em em-${d.direction}`);
  root.append(node("div", "view-title", "E/M level — documented vs billed"));

  const ladder = node("div", "ladder");
  for (const code of d.ladder || []) {
    const cell = node("div", "rung");
    const marks = node("div", "marks");
    if (code === d.supportedCode) marks.append(node("span", "mark mark-doc", "documented"));
    if (code === d.billedCode) marks.append(node("span", "mark mark-billed", "billed"));
    cell.append(node("div", "rung-code", code), marks);
    if (code === d.supportedCode) cell.classList.add("is-doc");
    if (code === d.billedCode) cell.classList.add("is-billed");
    ladder.append(cell);
  }
  root.append(ladder);

  const verdict = node("div", `em-verdict sev-${d.severity}`);
  verdict.append(
    node("strong", null,
      d.direction === "supported" ? "Matches the documentation"
      : d.direction === "above_documentation" ? `${d.distance} level(s) ABOVE the documentation`
      : `${d.distance} level(s) BELOW the documentation`),
    node("span", null, d.message),
  );
  root.append(verdict);

  const els = node("table", "em-elements");
  for (const e of d.elements || []) {
    const tr = node("tr");
    tr.append(node("td", "el-label", e.label), node("td", "el-level", e.level));
    els.append(tr);
  }
  root.append(els);
  root.append(node("p", "remedy", d.remedy));
  return root;
};

// ── kpi_tiles ────────────────────────────────────────────────────────────────

V.kpi_tiles = (d) => {
  const root = node("div", "toolview view-kpi");
  const grid = node("div", "kpi-grid");
  for (const t of d.tiles || []) grid.append(kpiTile(t));
  root.append(grid);
  return root;
};

function kpiTile(t) {
  const cell = node("div", "kpi-tile");
  // Null is rendered as "not computable", never as 0 — a zero reads as a
  // measurement, and every one of these metrics refuses rather than guessing.
  const computable = t.value !== null && t.value !== undefined;
  const R = 26, C = 2 * Math.PI * R;
  const ring = svg("svg", { viewBox: "0 0 64 64", class: "ring", role: "img", "aria-label": t.label });
  ring.append(svg("circle", { cx: 32, cy: 32, r: R, class: "ring-bg" }));
  if (computable && t.fraction !== undefined) {
    ring.append(svg("circle", {
      cx: 32, cy: 32, r: R, class: "ring-fg",
      "stroke-dasharray": `${Math.max(0, Math.min(1, t.fraction)) * C} ${C}`,
      transform: "rotate(-90 32 32)",
    }));
  }
  const txt = svg("text", { x: 32, y: 37, class: "ring-txt", "text-anchor": "middle" });
  txt.textContent = computable
    ? t.unit === "percent" ? `${Math.round(t.value)}%` : t.unit === "dollars" ? money(t.value) : String(Math.round(t.value))
    : "—";
  ring.append(txt);

  cell.append(ring, node("div", "kpi-label", t.label), node("div", "kpi-detail", computable ? t.detail : "not computable"));
  const note = node("div", "kpi-note", t.note);
  cell.append(note);
  return cell;
}

/** Render a view payload, or null when nothing knows how. */
function renderView(view) {
  if (!view || !V[view.kind]) return null;
  try {
    return V[view.kind](view.data ?? {});
  } catch (err) {
    // A malformed payload must not take the transcript down with it.
    const box = node("div", "toolview view-error", `Could not render ${view.kind}: ${err.message}`);
    return box;
  }
}

window.renderView = renderView;
