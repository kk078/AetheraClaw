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

// ── cms1500: the claim as the paper form ─────────────────────────────────────
// Box numbers, highlighting and the verdict all arrive decided from
// src/views/cms1500.ts. Nothing here inspects a rule name or works out which
// field a finding belongs to — that attribution is a domain judgement and it is
// tested on the server.

V.cms1500 = (d) => {
  const root = node("div", "toolview view-1500");

  if (d.verdict) {
    const v = node("div", `verdict verdict-${d.verdict}`);
    v.append(
      node("strong", null, { hold: "HOLD", review: "REVIEW", clear: "CLEAR" }[d.verdict]),
      node("span", null,
        d.verdict === "hold" ? "Do not submit as it stands."
        : d.verdict === "review" ? "A biller should look at the highlighted boxes before it goes out."
        : "No box carries a finding."),
    );
    root.append(v);
  }

  const head = node("div", "form-head");
  head.append(
    node("span", "form-title", "CMS-1500 (02/12)"),
    node("span", "claim-id", d.claimId || "(no claim id)"),
    node("span", "payer", d.payer || ""),
  );
  root.append(head);

  const grid = node("div", "form-grid");
  for (const c of d.header ?? []) grid.append(formBox(c));
  root.append(grid);

  // Box 21 — letters, because that is what the form prints and what 24E points at.
  if (d.diagnoses?.length) {
    const dx = node("div", "form-dx");
    dx.append(node("div", "box-label", "21  Diagnosis or nature of illness or injury"));
    const row = node("div", "dx-row");
    for (const g of d.diagnoses ?? []) {
      const cellEl = node("div", `dx-cell sev-${g.severity}${g.unused ? " unused" : ""}`);
      cellEl.append(node("span", "dx-ptr", g.pointer), node("span", "dx-code", g.code));
      if (g.unused) cellEl.append(node("span", "dx-note", "no line points here"));
      for (const m of g.findings ?? []) cellEl.append(node("div", "box-finding", m));
      row.append(cellEl);
    }
    dx.append(row);
    root.append(dx);
  }

  const table = node("table", "lines form-lines");
  const thead = node("thead");
  const hr = node("tr");
  for (const h of ["", "24A", "24B", "24D", "24E", "24F", "24G", "24J"]) hr.append(node("th", null, h));
  thead.append(hr);
  table.append(thead);

  const tbody = node("tbody");
  for (const line of d.lines ?? []) {
    const tr = node("tr", `sev-${line.severity}`);
    tr.append(node("td", "num", String(line.index)));
    for (const box of ["24A", "24B", "24D", "24E", "24F", "24G", "24J"]) {
      const c = (line.cells ?? []).find((x) => x.box === box);
      const td = node("td", c && c.severity !== "clean" ? `cell sev-${c.severity}` : "cell");
      td.append(node("span", null, (c && c.value) || "—"));
      tr.append(td);
    }
    tbody.append(tr);

    const flagged = (line.cells ?? []).filter((c) => c.findings?.length);
    if (flagged.length) {
      const detail = node("tr", "detail-row");
      const td = node("td");
      td.colSpan = 8;
      for (const c of flagged) {
        for (const m of c.findings) {
          const f = node("div", `finding f-${c.severity}`);
          const fh = node("div", "f-head");
          fh.append(node("span", "f-rule", `box ${c.box}`), node("span", "f-msg", m));
          f.append(fh);
          td.append(f);
        }
      }
      detail.append(td);
      tbody.append(detail);
    }
  }
  table.append(tbody);
  root.append(table);

  const total = node("div", "form-total");
  total.append(node("span", "box-label", "28  Total charge"), node("span", "total", money(d.totalCharge)));
  root.append(total);

  // Below the form, never inside it. These are facts about the practice or the
  // installation, and putting one in a box would say the claim is wrong where
  // it is not.
  if (d.unattributed?.length) {
    const off = node("div", "form-offform");
    off.append(node("div", "bs-head", `${d.unattributed.length} finding(s) that belong to no box on this form`));
    for (const u of d.unattributed) {
      const f = node("div", `finding f-${u.severity}`);
      const fh = node("div", "f-head");
      fh.append(node("span", "f-rule", u.rule), node("span", "f-msg", u.message));
      f.append(fh);
      off.append(f);
    }
    root.append(off);
  }

  return root;
};

function formBox(c) {
  const b = node("div", `form-box${c.severity && c.severity !== "clean" ? ` sev-${c.severity}` : ""}`);
  b.append(node("div", "box-label", `${c.box}  ${c.label}`), node("div", "box-value", c.value || "—"));
  for (const m of c.findings ?? []) b.append(node("div", "box-finding", m));
  return b;
}

// ── appeal_letter: read and print, never edit ────────────────────────────────
// The editable artifact is the Markdown file appeal_draft wrote into the
// workspace. This panel is for reading it and sending it to the printer through
// the existing print stylesheet; it deliberately has no editing affordance,
// because a browser panel whose changes vanish on refresh loses work silently.

V.appeal_letter = (d) => {
  const root = node("div", "toolview view-appeal");

  if (d.citationWarning) {
    const w = node("div", `verdict verdict-${d.citationWarning.severity === "error" ? "hold" : "review"}`);
    w.append(
      node("strong", null, d.citationWarning.severity === "error" ? "CITATIONS UNVERIFIED" : "NO POLICY CITED"),
      node("span", null, d.citationWarning.text),
    );
    root.append(w);
  }

  const meta = node("div", "form-grid");
  for (const [label, value] of [
    ["To", d.recipient],
    ["Re", d.patientReference],
    ["Claim", `${d.claimId}  ·  DOS ${d.serviceDate}`],
    ["Denial", d.carcDescription ? `CARC ${d.carc} — ${d.carcDescription}` : `CARC ${d.carc}`],
  ]) {
    const b = node("div", "form-box");
    b.append(node("div", "box-label", label), node("div", "box-value", value || "—"));
    meta.append(b);
  }
  root.append(meta);

  for (const s of d.sections ?? []) {
    const sec = node("div", "appeal-section");
    sec.append(node("h4", null, s.heading), node("p", null, s.body));
    root.append(sec);
  }

  const cites = node("div", "appeal-section");
  cites.append(node("h4", null, "Applicable coverage policy"));
  if ((d.citations ?? []).length === 0) {
    cites.append(node("p", "muted", "None cited."));
  } else {
    const ul = node("ul");
    for (const c of d.citations) ul.append(node("li", null, c));
    cites.append(ul);
  }
  root.append(cites);

  // Where the real document is. Said plainly so nobody types into this panel
  // expecting it to stick.
  const foot = node("div", "appeal-foot");
  foot.append(node("span", "box-label", "Editable file"), node("code", null, d.filePath));
  foot.append(node("span", "muted", "Edit the file, not this panel — this view is for reading and printing."));
  root.append(foot);

  return root;
};

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

// ── Workflow card ────────────────────────────────────────────────────────────
// The wrapper the console shows instead of a `tool_invoke` box. It carries the
// verdict badge, the sentence the verdict rests on, the headline facts, and the
// rendered view — with the raw telemetry (input JSON, returned text) tucked into
// a toggle underneath, because the text is what the model saw and dropping it
// would make the transcript a worse record than the log it replaced.
//
// The badge is NOT decided here. `card` arrives pre-computed from the server
// (src/views/verdict.ts) for exactly the reason the header of this file gives
// for severity: a badge is trusted more than the prose under it.

function workflowCard(card, toolName, at) {
  const box = node("div", "wfcard");
  if (card.verdict) box.classList.add(`v-${card.verdict}`);

  const head = node("div", "wfhead");
  const left = node("div", "wfhead-l");
  if (card.verdict) left.append(node("span", `vbadge ${card.verdict}`, card.verdictLabel || card.verdict));
  left.append(node("h3", null, card.title || toolName));
  head.append(left, node("span", "wftime", at));
  box.append(head);

  if (card.facts?.length) {
    const grid = node("div", "wffacts");
    for (const f of card.facts) {
      const cell = node("div", "wffact");
      cell.append(node("span", "k", f.label), node("span", "v", f.value));
      grid.append(cell);
    }
    box.append(grid);
  }
  if (card.because) box.append(node("p", "wfbecause", card.because));
  return box;
}

/** The collapsed technical log that sits under a card. */
function telemetry(toolName, input, output, isError) {
  const d = node("details", "wftel");
  const s = node("summary");
  s.append(node("code", null, toolName), node("span", "wftel-hint", "View raw tool telemetry"));
  if (isError) s.append(node("span", "vbadge hold", "FAILED"));
  d.append(s);
  if (input !== undefined) {
    d.append(node("div", "wftel-label", "input"));
    d.append(node("pre", null, JSON.stringify(input ?? {}, null, 2)));
  }
  d.append(node("div", "wftel-label", "returned to the model"));
  const pre = node("pre", null, String(output ?? ""));
  if (isError) pre.classList.add("err");
  d.append(pre);
  return d;
}

window.workflowCard = workflowCard;
window.toolTelemetry = telemetry;
