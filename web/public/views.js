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
      const flagged = c && c.severity !== "clean";
      const td = node("td", flagged ? `cell sev-${c.severity} clickable` : "cell");
      td.append(node("span", null, (c && c.value) || "—"));
      if (flagged) td.addEventListener("click", (ev) => openFixPanel(ev.currentTarget, c));
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
  const flagged = c.severity && c.severity !== "clean";
  const b = node("div", `form-box${flagged ? ` sev-${c.severity} clickable` : ""}`);
  b.append(node("div", "box-label", `${c.box}  ${c.label}`), node("div", "box-value", c.value || "—"));
  // Findings move into the popover when the box is clickable — printing them
  // under every box turns the form back into the list it replaced.
  if (flagged) b.addEventListener("click", (ev) => openFixPanel(ev.currentTarget, c));
  else for (const m of c.findings ?? []) b.append(node("div", "box-finding", m));
  return b;
}

// ── Contextual fix panel ─────────────────────────────────────────────────────
// Clicking a flagged box opens the finding ON the field rather than sending the
// reader to a list underneath. It offers a QUESTION and never a fix button:
// the server decides which repairs are safe to apply (see ClaimFindingView.fix),
// and nothing in this payload carries that permission — so a one-click "fix"
// here would be the UI inventing an authority the engine deliberately withheld.

let openPop = null;

function closeFixPanel() {
  openPop?.remove();
  openPop = null;
}

function openFixPanel(anchor, cell) {
  closeFixPanel();
  const pop = node("div", "fixpop");
  const close = node("span", "fp-close", "✕");
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFixPanel();
  });
  pop.append(
    close,
    node("div", "fp-box", `Box ${cell.box} — ${cell.label}`),
    node("div", "fp-val", cell.value || "(empty)"),
  );
  for (const m of cell.findings ?? []) pop.append(node("p", "fp-msg", m));

  const ask = node("button", "btn ghost sm fp-ask", "Ask about this box");
  ask.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFixPanel();
    // Hands it to the console rather than editing the claim here. The claim is
    // the model's to change, through the same approval gate as everything else.
    window.askAboutBox?.(cell.box, cell.label, cell.findings ?? []);
  });
  pop.append(ask);

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 12, r.bottom + 6)}px`;
  pop.style.left = `${Math.min(window.innerWidth - pop.offsetWidth - 12, r.left)}px`;
  openPop = pop;
  setTimeout(() => document.addEventListener("click", closeFixPanel, { once: true }), 0);
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

// ── batch_heal: the capacity answer, and nothing applied ─────────────────────
// The four numbers are the point: how many claims go out as they are, how many
// a safe repair covers, how many need a person, and how many rows could not be
// read at all. The last is shown even at zero, because its absence is what
// would quietly inflate the other three.

V.batch_heal = (d) => {
  const root = node("div", "toolview view-batch");

  const bar = node("div", "bh-bar");
  const total = Math.max(1, Number(d.total || 0));
  const seg = (cls, n, label) => {
    if (!n) return;
    const s = node("div", `bh-seg ${cls}`);
    s.style.flexGrow = String(n);
    s.title = `${n} ${label}`;
    s.append(node("span", null, String(n)));
    bar.append(s);
  };
  seg("clean", d.clean, "clean as they stand");
  seg("repair", d.repairable, "a safe repair away");
  seg("human", d.needsHuman, "need a person");
  if (d.total) root.append(bar);

  const legend = node("div", "bh-legend");
  legend.append(
    node("span", "bh-key clean", `${d.clean || 0} clean`),
    node("span", "bh-key repair", `${d.repairable || 0} repairable`),
    node("span", "bh-key human", `${d.needsHuman || 0} need a person`),
  );
  root.append(legend);

  const ruleList = (title, rows, withQuestion) => {
    if (!rows?.length) return;
    root.append(node("h4", "bh-head", title));
    const list = node("div", "bh-rules");
    for (const r of rows) {
      const row = node("div", "bh-rule");
      row.append(node("code", null, r.rule), node("span", "bh-count", `${r.count} claim(s)`));
      if (withQuestion && r.question) row.append(node("span", "bh-q", r.question));
      list.append(row);
    }
    root.append(list);
  };
  // Grouped by rule because one rule across many claims is usually one upstream
  // fault, not many independent ones.
  ruleList("Safe repairs available, by rule", d.repairsByRule, false);
  ruleList("Needs a person, by rule", d.reviewsByRule, true);

  const notes = [];
  if (d.excluded > 0) {
    notes.push(`${d.excluded} stored row(s) did not parse as a claim. They are excluded from every number above — not counted as clean.`);
  }
  if (d.truncated) notes.push("The row limit was reached, so the real batch may be larger than what was measured.");
  notes.push("Nothing here has been applied. There is deliberately no batch apply — a repair is made one claim at a time, through the same gate as everything else.");
  const foot = node("div", "bh-foot");
  for (const n of notes) foot.append(node("p", null, n));
  root.append(foot);

  return root;
};

// ── document: an uploaded file, read or refused ──────────────────────────────
// The refusal is the headline when there is one. "Cannot be read, and here is
// why, and here is what to do instead" is a useful screen; an empty text pane
// is not.

V.document = (d) => {
  const root = node("div", "toolview view-doc");

  const head = node("div", "doc-head");
  head.append(node("span", "doc-name", d.filename), node("span", "doc-kind", d.kind));
  head.append(node("span", "doc-size", `${(d.sizeBytes / 1024).toFixed(1)} KB`));
  root.append(head);

  if (!d.readable) {
    const box = node("div", "doc-refusal");
    box.append(node("div", "doc-refusal-h", "Not read"));
    box.append(node("p", null, d.refusal));
    root.append(box);
    for (const n of d.notes || []) root.append(node("p", "doc-note", n));
    return root;
  }

  if (d.phi?.length) {
    // Shown above the text, not below it. Somebody scrolling a denial letter
    // should not learn afterwards that its content is being retained.
    const warn = node("div", "doc-phi");
    warn.append(node("div", "doc-phi-h", "Identifier-shaped text found"));
    warn.append(
      node("p", null, `${d.phi.map((p) => `${p.kind} ×${p.count}`).join(", ")}. The extracted text is stored in this database.`),
    );
    warn.append(
      node("p", "doc-phi-sub", "Pattern matching finds identifiers with a shape. A patient name in prose has none and is not counted here."),
    );
    root.append(warn);
  }

  const meta = node("div", "doc-meta");
  meta.append(node("span", null, `${Number(d.characters || 0).toLocaleString("en-US")} characters`));
  meta.append(node("span", null, `${d.sections.length} section(s)`));
  if (d.confidence < 1) meta.append(node("span", null, `${Math.round(d.confidence * 100)}% of glyphs mapped`));
  root.append(meta);

  for (const n of d.notes || []) root.append(node("p", "doc-note", n));

  for (const s of d.sections) {
    const sec = node("details", "doc-section");
    // The first section open, the rest closed: a 40-page ADR should not push
    // everything else off the screen, and page 1 is where people start.
    if (d.sections.indexOf(s) === 0) sec.open = true;
    sec.append(node("summary", null, `${s.label} — ${Number(s.characters).toLocaleString("en-US")} characters`));
    sec.append(node("pre", "doc-text", s.text));
    root.append(sec);
  }

  return root;
};

// ── archive_manifest: what happened to each file in a dropped .zip ───────────
// One row per entry, worst first, because the operator opened this panel to
// find the files that did not make it — not to admire the ones that did.
//
// Nothing here decides anything. The status on each row, the ordering, the
// counts and the number of entries the cap left out were all settled in
// src/views/archive.ts; this paints them. And every cell is built with
// textContent: the filenames come from an archive a stranger assembled, and
// `.zip` entry names are the one string in this system most obviously chosen
// by somebody else.
//
// The root keeps `view-doc` so the document view's header, note and refusal
// styling applies — an archive manifest is the same kind of object, read at a
// different scale, and a second palette for it would be a second thing to keep
// in sync.

const ARCH_CHIP = { read: "chip-ok", ocr: "chip-phi", refused: "chip-bad", skipped: "chip-bad" };
const ARCH_LABEL = { read: "read", ocr: "OCR", refused: "refused", skipped: "not decoded" };

V.archive_manifest = (d) => {
  const root = node("div", "toolview view-doc view-archive");

  const head = node("div", "doc-head");
  head.append(node("span", "doc-name", d.filename || "(unnamed archive)"));
  head.append(node("span", "doc-kind", "archive"));
  head.append(node("span", "doc-size", `${Number(d.total || 0)} entry(s)`));
  root.append(head);

  // A run in flight is marked before anything else on the panel. The counts
  // below are true of what has been processed so far and of nothing more, and
  // a half-finished manifest read as a finished one is how a missing file gets
  // signed off on.
  if (d.status === "processing") {
    root.append(
      node("div", "banner", "Still extracting. These rows are what has been processed so far — entries may still be added, and no count below is final."),
    );
  } else if (d.status === "failed") {
    const box = node("div", "doc-refusal");
    box.append(node("div", "doc-refusal-h", "Archive failed"));
    box.append(node("p", null, "Processing stopped before the archive was finished. Whatever is listed below is partial."));
    root.append(box);
  }

  const meta = node("div", "doc-meta");
  meta.append(node("span", null, `${Number(d.read || 0)} read`));
  meta.append(node("span", null, `${Number(d.ocr || 0)} OCR`));
  meta.append(node("span", null, `${Number(d.refused || 0)} refused`));
  // Shown at zero as well: an absent "0 not decoded" is the line that would let
  // the other three add up to something that looks complete.
  meta.append(node("span", null, `${Number(d.skipped || 0)} not decoded`));
  root.append(meta);

  const table = node("table", "lines");
  const thead = node("thead");
  const hr = node("tr");
  for (const h of ["File", "Type", "Status", "Chars", "Identifiers", "Routed to / why"]) hr.append(node("th", null, h));
  thead.append(hr);
  table.append(thead);

  const tbody = node("tbody");
  for (const r of d.rows ?? []) {
    const tr = node("tr", `arch-${r.status}`);

    tr.append(node("td", "code", r.filename || "(unnamed)"));
    tr.append(node("td", null, r.kind || "—"));

    const st = node("td");
    const chip = node("span", `chip ${ARCH_CHIP[r.status] || ""}`);
    chip.append(node("span", "chip-name", ARCH_LABEL[r.status] || r.status || "—"));
    st.append(chip);
    tr.append(st);

    // An entry that was refused has no character count to report, and a 0
    // there reads as "read it, found nothing in it".
    tr.append(node("td", "num", r.status === "read" || r.status === "ocr" ? Number(r.characters || 0).toLocaleString("en-US") : "—"));

    // Kinds only. The server sends no values and no counts, so there is
    // nothing here to leak even by accident.
    tr.append(node("td", null, (r.phi || []).join(", ") || "—"));

    const last = node("td");
    if (r.routeTo) last.append(node("code", null, r.routeTo));
    if (r.classification) last.append(node("span", "doc-size", r.classification));
    // The refusal reason, verbatim from the reader. It is the only thing on the
    // row that tells the operator what to do next.
    if (r.detail) last.append(node("span", "arch-detail", r.detail));
    if (!last.childNodes.length) last.append(node("span", null, "—"));
    tr.append(last);

    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);

  // The cap is stated, never silent. "and 214 more" is a smaller table than the
  // archive; a table that just stops is a wrong one.
  if (Number(d.truncated || 0) > 0) {
    root.append(
      node("p", "doc-note", `${d.truncated} further entry(s) are not listed — the table shows the first ${(d.rows ?? []).length}, worst first, so nothing needing a person was cut before a file that read cleanly.`),
    );
  }
  for (const n of d.notes || []) root.append(node("p", "doc-note", n));

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
