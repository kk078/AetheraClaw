// Orion console. Vanilla JS, no build step.

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  sessionId: null,
  ws: null,
  modules: [],
  tools: [],
  turnRunning: false,
  pendingApproval: null,
};

// ── Navigation ─────────────────────────────────────────────────────────

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll(".navitem").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  if (view === "console") $("#input").focus();
  // Loaded on open rather than at boot: it reads the credentials file, and
  // there is no reason to touch that on every page load of a console nobody
  // opened the settings screen from.
  if (view === "providers") loadProviders();
}
/**
 * Domain nav items load a starter prompt into the console.
 *
 * They are not pages and do not pretend to be. Every one of these is a tool
 * that already works from the console, and a nav item opening an empty screen
 * headed "Denial Management" would be worse than one that does the thing.
 */
// Every nav item loads a starter prompt rather than opening a page. They are
// not pages and do not pretend to be: each of these is a tool that already
// works from the console, and a nav item opening an empty screen headed
// "Denial Management" would be worse than one that does the thing.
const DOMAIN_PROMPTS = {
  // Operations
  claims: "Show me the claims on file with their status, and flag any that have not been acknowledged.",
  worklist: "Show the worklist prioritised by what is recoverable and what is closest to a deadline.",
  mail: "Sweep the inbox by urgency and tell me what is held, what carries a deadline inside a week, and what could not be placed.",
  // Scrub & compliance
  presubmit: "Run the pre-submission gate on my most recent claim and tell me whether it is safe to send.",
  em: "Check the E/M levels I have billed against the documentation, in both directions.",
  ncci: "Check which NCCI and MUE data is installed, then tell me what bundling can and cannot be checked right now.",
  // Financials
  money: "Run the KPI dashboard, then reconcile the most recent remittance against what the payer says it sent.",
  variance: "Show me payment variance for anything underpaid, and say which basis you measured against.",
  denials: "Show me the open denial worklist, sorted by what is recoverable and what is closest to a deadline.",
  cob: "Determine payer order for a secondary claim and check that charge = paid + adjustments on every line.",
  // Ops & support
  trace: "Trace claim ",
  fmea: "Diagnose the tool failures from the last 24 hours and tell me whether this is one incident or several.",
  patch: "Preview a batch auto-heal across the claims on file — show me what would change, and change nothing.",
  telemetry: "Check Ollama telemetry, dataset health, tenant database integrity, and which reference code sets are attached.",
};

document.querySelectorAll(".navitem").forEach((n) =>
  n.addEventListener("click", () => {
    if (n.dataset.view) return show(n.dataset.view);
    const prompt = DOMAIN_PROMPTS[n.dataset.domain];
    if (!prompt) return;
    show("console");
    $("#input").value = prompt;
    $("#input").focus();
  }),
);

// ── Overview ───────────────────────────────────────────────────────────

const STARTERS = [
  ["Is E11.65 billable, and what does it mean?", "◈", "Coding", "Looks the code up rather than recalling it — the installed FY table first, NLM if there is none, and it says which answered."],
  ["I got CARC 197 on a claim. What is it and what do I do?", "▽", "Denials", "Resolves the code rather than recalling it, then gives the remediation path."],
  ["Is a Medicare claim with date of service 20250715 still filable today?", "◷", "Timely filing", "One calendar year by statute, computed so a leap day cannot shift it."],
  ["Scrub this claim and tell me exactly what is wrong with it.", "▣", "Claim scrub", "Severity-ranked findings; a dangling diagnosis pointer is an error, not a warning."],
  ["Draft a compliant physician query for unspecified heart failure.", "◉", "CDI", "Refuses to emit a leading query rather than warning about one."],
  ["What does the tool catalogue have for prior authorization?", "⌘", "Catalogue", "Searches all tools, including the ones not loaded into this turn."],
];

/**
 * Three KPI tiles, each of which can decline to show a number.
 *
 * The whole discipline of the KPI module is refusing to state a figure it cannot
 * support — days in A/R with no charges to divide by, a collection rate over
 * claims too recent to have finished paying. Rendering those as 0 would undo it
 * silently and read as "we collect instantly", which is the one wrong answer
 * that looks like good news. So a null shows as "—" with the reason underneath.
 */
function renderKpiTiles(kpis) {
  const wrap = $("#ov-kpi-wrap");
  if (!kpis) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const tiles = [
    ["Days in A/R", kpis.daysInAr, (v) => String(v), kpis.notes.daysInAr],
    ["Front-end acceptance", kpis.acceptanceRate, (v) => `${v.toFixed(1)}%`, kpis.notes.acceptanceRate],
    ["Net collection", kpis.netCollectionRate, (v) => `${v.toFixed(1)}%`, kpis.notes.netCollectionRate],
  ];

  $("#ov-kpis").replaceChildren(
    ...tiles.map(([label, value, fmt]) => {
      const d = el("div", `stat${value === null ? " zero" : ""}`);
      d.append(el("div", "v", value === null ? "—" : fmt(value)), el("div", "k", label));
      return d;
    }),
  );

  // The note for whichever tile is withheld, since that is the one somebody is
  // about to ask about. If they all computed, the A/R denominator caveat is the
  // one that decides whether the number is comparable to a published benchmark.
  const withheld = tiles.find(([, v]) => v === null);
  $("#ov-kpi-note").textContent =
    kpis.skipped ?? (withheld ? withheld[3] : tiles[0][3]) ?? "";
}

/**
 * The operational strip in the header.
 *
 * Only figures this database can actually support. A ticker showing a hardcoded
 * "94.2%" would be the most-read number in the product and a lie, so a metric
 * with nothing behind it is omitted rather than filled in — and the strip is
 * empty on a fresh install, which is the correct amount to say.
 */
function renderTicker(ov) {
  const ticks = [];
  const k = ov.kpis;
  if (k && k.acceptanceRate !== null) ticks.push(["Clean claim rate", `${k.acceptanceRate.toFixed(1)}%`, false]);
  if (k && k.daysInAr !== null) ticks.push(["Days in A/R", String(k.daysInAr), false]);
  if (ov.counts?.worklist) ticks.push(["Open worklist", `${ov.counts.worklist}`, ov.counts.worklist > 0]);
  if (ov.counts?.heldMail) ticks.push(["Mail held", `${ov.counts.heldMail}`, true]);

  $("#ticker").replaceChildren(
    ...ticks.map(([label, value, warn]) => {
      const d = el("div", `tick${warn ? " warn" : ""}`);
      d.append(el("b", null, value), el("span", null, label));
      return d;
    }),
  );
}

async function loadOverview() {
  const ov = await fetch("/api/overview").then((r) => r.json()).catch(() => null);
  if (!ov) {
    // This IS the reachability check, and it just failed — the one case where
    // red is the correct thing to show.
    setConn("bad", "gateway unreachable");
    return;
  }
  // It answered, so the gateway is up whatever the socket is doing.
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) setConn("idle", "no session");

  $("#pill-provider").innerHTML =
    `<span class="dot on"></span><b>${ov.model}</b>` + (ov.endpoint ? ` · ${ov.endpoint}` : "");
  $("#pill-driver").textContent = ov.driver;
  // The workspace is the one path everything the agent writes lands under, so
  // the footer says where it is AND how to move it. Not editable from here on
  // purpose: a browser control that rewrites the confinement root is one
  // injected instruction away from being the way out of the confinement.
  $("#foot").textContent = ov.workspace;
  $("#foot").title =
    `Everything the agent writes lands here.\n\nMove it with:  orion serve --workspace /path/to/folder\n` +
    `Or permanently, workspaceRoot in ~/.orion/config.json5.\n\n` +
    `Writes are confined to this folder wherever it points — ../, absolute paths and symlink escapes are refused.`;

  const runtime = [
    ["Provider", ov.provider],
    ["Model", ov.model],
    ["Tool profile", ov.profile],
    ["Approvals", ov.approvalPolicy],
    ["SQLite", ov.driver],
  ];
  $("#ov-runtime").replaceChildren(
    ...runtime.map(([k, v]) => {
      const d = el("div", "stat");
      const val = el("div", "v", String(v));
      val.style.fontSize = "14px";
      d.append(val, el("div", "k", k));
      return d;
    }),
  );

  const labels = {
    sessions: "Sessions", messages: "Messages", claims: "Claims", remittances: "Remittances",
    worklist: "Worklist", suggestions: "Suggestions", audit: "Audit entries",
    heldMail: "Mail held",
  };
  $("#ov-counts").replaceChildren(
    ...Object.entries(ov.counts).map(([k, v]) => {
      const d = el("div", `stat${v === 0 ? " zero" : ""}`);
      d.append(el("div", "v", String(v)), el("div", "k", labels[k] ?? k));
      return d;
    }),
  );

  renderKpiTiles(ov.kpis);
  renderTicker(ov);

  $("#ov-starters").replaceChildren(
    ...STARTERS.map(([prompt, glyph, tag, why]) => {
      const c = el("div", "card click");
      const head = el("div", "head");
      head.append(el("div", "glyph", glyph), el("h4", null, tag));
      c.append(head, el("p", null, prompt), el("div", "note", why));
      c.addEventListener("click", () => {
        show("console");
        $("#input").value = prompt;
        $("#input").focus();
      });
      return c;
    }),
  );
}

// ── Modules ────────────────────────────────────────────────────────────

async function loadModules() {
  const data = await fetch("/api/modules").then((r) => r.json()).catch(() => null);
  if (!data) return;
  state.modules = data.modules;
  state.tools = data.modules.flatMap((m) => m.tools.map((t) => ({ ...t, module: m.label })));

  $("#ov-total").textContent = data.total;
  $("#ov-modcount").textContent = data.modules.length;
  $("#c-modules").textContent = data.modules.length;
  $("#palette-input").placeholder = `Search ${data.total} tools…`;
  $("#pill-tools").innerHTML =
    `<b>${data.loadedDirectly}</b> loaded` + (data.deferred ? ` · ${data.deferred} on demand` : "");
  $("#pill-tools").title = data.deferred
    ? `${data.deferred} tools are reachable through tool_search rather than sent every turn.`
    : "Every tool is sent directly.";
  renderModules("");
}

function renderModules(filter) {
  const q = filter.trim().toLowerCase();
  const grid = $("#module-grid");
  grid.replaceChildren();

  for (const m of state.modules) {
    const hits = q
      ? m.tools.filter((t) => t.name.includes(q) || t.summary.toLowerCase().includes(q))
      : m.tools;
    const moduleMatches = !q || m.label.toLowerCase().includes(q) || m.blurb.toLowerCase().includes(q);
    if (!moduleMatches && hits.length === 0) continue;
    const tools = moduleMatches && hits.length === 0 ? m.tools : hits;

    const card = el("div", "card");
    card.style.marginBottom = "12px";
    const head = el("div", "head");
    head.append(el("div", "glyph", m.glyph), el("h4", null, m.label), el("div", "n", `${m.tools.length} tools`));
    card.append(head, el("p", null, m.blurb), el("div", "note", m.note));

    const list = el("div");
    list.style.marginTop = "10px";
    for (const t of tools) {
      const row = el("div", "toolrow");
      row.append(el("code", null, t.name), el("span", null, t.summary));
      row.append(el("span", `badge ${t.loaded ? "loaded" : "deferred"}`, t.loaded ? "loaded" : "on demand"));
      row.addEventListener("click", () => openTool(t));
      list.append(row);
    }
    card.append(list);
    grid.append(card);
  }
  if (!grid.children.length) grid.append(el("p", "sub", `Nothing matches "${filter}".`));
}

$("#module-search").addEventListener("input", (e) => renderModules(e.target.value));

// ── Tool detail ────────────────────────────────────────────────────────

let currentTool = null;
function openTool(t) {
  currentTool = t;
  $("#tool-title").textContent = t.name;
  $("#tool-desc").textContent = t.description;
  $("#tool-schema").textContent = `Module: ${t.module ?? ""}\nLoaded this turn: ${t.loaded ? "yes — sent directly" : "no — reached through tool_search"}`;
  $("#tool-scrim").classList.add("show");
}
$("#tool-use").addEventListener("click", () => {
  if (!currentTool) return;
  $("#tool-scrim").classList.remove("show");
  show("console");
  $("#input").value = `Use the ${currentTool.name} tool. `;
  $("#input").focus();
});
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest(".scrim").classList.remove("show")),
);
document.querySelectorAll(".scrim").forEach((s) =>
  s.addEventListener("click", (e) => {
    if (e.target === s && s.id !== "approve-scrim") s.classList.remove("show");
  }),
);

// ── Command palette ────────────────────────────────────────────────────

function openPalette() {
  $("#palette-scrim").classList.add("show");
  $("#palette-input").value = "";
  renderPalette("");
  $("#palette-input").focus();
}
function renderPalette(q) {
  const query = q.trim().toLowerCase();
  const hits = (query
    ? state.tools.filter((t) => t.name.includes(query) || t.summary.toLowerCase().includes(query))
    : state.tools
  ).slice(0, 40);
  $("#palette-results").replaceChildren(
    ...hits.map((t) => {
      const row = el("div", "paletteitem");
      row.append(el("code", null, t.name), el("span", null, t.summary));
      row.addEventListener("click", () => {
        $("#palette-scrim").classList.remove("show");
        openTool(t);
      });
      return row;
    }),
  );
  if (!hits.length) $("#palette-results").append(el("p", "sub", "No tool matches that."));
}
$("#palette-input").addEventListener("input", (e) => renderPalette(e.target.value));
$("#btn-palette").addEventListener("click", openPalette);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
  }
  if (e.key === "Escape") document.querySelectorAll(".scrim.show").forEach((s) => {
    if (s.id !== "approve-scrim") s.classList.remove("show");
  });
});

// ── Sessions ───────────────────────────────────────────────────────────

async function loadSessions() {
  const rows = await fetch("/api/sessions").then((r) => r.json()).catch(() => []);
  const list = $("#session-list");
  list.replaceChildren();

  const nu = el("div", "sessionrow", "+ New session");
  nu.style.color = "var(--accent)";
  nu.addEventListener("click", newSession);
  list.append(nu);

  for (const s of rows) {
    const row = el("div", `sessionrow${s.id === state.sessionId ? " active" : ""}`);
    row.append(document.createTextNode(s.title || "(untitled)"));
    row.append(el("small", null, new Date(s.updated_at).toLocaleString()));
    row.addEventListener("click", () => openSession(s.id));
    list.append(row);
  }
}

async function newSession() {
  const s = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  await openSession(s.id);
}

async function openSession(id) {
  state.sessionId = id;
  show("console");
  const stream = $("#stream");
  stream.replaceChildren();

  // Views live outside the message stream so they never enter the model's
  // context, which means replaying a session needs this second fetch.
  const [messages, views] = await Promise.all([
    fetch(`/api/sessions/${id}/messages`).then((r) => r.json()).catch(() => []),
    fetch(`/api/sessions/${id}/views`).then((r) => r.json()).catch(() => ({})),
  ]);
  // A stored tool_result carries no tool name — only the id linking it to the
  // tool_use that requested it. Replay therefore has to keep that link, or a
  // replayed session shows a section for every catalogue call while the live
  // one collapses them: the same conversation, two different shapes.
  const calledName = new Map();
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "text" && block.text.trim()) addMessage(m.role, block.text);
      else if (block.type === "tool_use") {
        // tool_invoke is a wrapper; the tool that actually ran is named in its
        // input. Resolving it here mirrors what the runner does live, so a
        // replayed turn reports the same tool the original one did.
        const inner = block.name === "tool_invoke" ? String(block.input?.name ?? "").trim() : "";
        calledName.set(block.id, inner || block.name);
        addTool(block.name, block.input);
      } else if (block.type === "tool_result") {
        const name = calledName.get(block.toolUseId) ?? "";
        finishTool(block.content, block.isError, views[block.toolUseId], name, PLUMBING.has(name));
      }
    }
  }
  // A session with nothing in it is the same blank console as a fresh page, and
  // the invitation belongs on both. Replacing the stream wholesale used to take
  // the empty state with it and leave a void.
  if ($("#stream").children.length === 0) $("#stream").append(emptyState());
  endGroup();
  connect(id);
  loadSessions();
}

/** Mirrors PLUMBING_TOOLS in src/views/workflow.ts, for replay only. */
const PLUMBING = new Set(["tool_search", "tool_describe", "tool_invoke"]);

function emptyState() {
  const box = el("div", "empty");
  box.append(el("div", "big", "Ask about codes, coverage, claims, denials or cash."));
  box.append(el("div", null, "The agent runs real tools and shows every call it makes."));
  box.append(el("div", null, "Drop in a PDF, Word or Excel file and it will read that too."));
  return box;
}


// ── Markdown ───────────────────────────────────────────────────────────
// Models answer in Markdown, and showing it raw means **bold**, pipe tables and
// literal <br> in the transcript. This is deliberately small: escape everything
// first, then re-introduce a fixed set of tags. Escaping before formatting is
// the whole safety argument — model output is untrusted text, and it reaches
// this function having passed through a payer's API on the way.

function esc(t) {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Models emit a literal <br> inside table cells; it is escaped above, so
    // turn the escaped form back into a real break rather than leaving "&lt;br&gt;".
    .replace(/&lt;br\s*\/?&gt;/g, "<br>");
}

function renderMarkdown(text) {
  const lines = String(text).split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code">${esc(body.join("\n"))}</pre>`);
      continue;
    }

    // A table needs its separator row; without it these are just pipes.
    if (/\|/.test(line) && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table class="md-table"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(`<div class="md-h">${inline(heading[2])}</div>`);
      i++;
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && (/^\s*[-*•]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(inline(lines[i].replace(/^\s*(?:[-*•]|\d+\.)\s+/, "")));
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"} class="md-list">${items.map((t) => `<li>${t}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    if (line.trim() === "") { out.push(""); i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|```|\s*[-*•]\s|\s*\d+\.\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p class="md-p">${inline(para.join("\n"))}</p>`);
  }
  return out.join("");
}

// ── Stream rendering ───────────────────────────────────────────────────

let liveBubble = null;
let liveTool = null;

function addMessage(role, text) {
  $("#stream").querySelector(".empty")?.remove();
  const wrap = el("div", `msg ${role}`);
  const bubble = el("div", "bubble");
  if (role === "assistant") {
    bubble.dataset.raw = text;
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  wrap.append(bubble);
  $("#stream").append(wrap);
  scroll();
  return bubble;
}

function addTool(name, input) {
  $("#stream").querySelector(".empty")?.remove();
  // A running call is a thin line, not a card. The card is what the RESULT
  // earns: printing a card shell up front means every in-flight call looks like
  // a finished verdict for as long as it takes to run.
  const d = el("div", "running");
  d.append(el("span", "spin"), el("code", null, name), el("span", "st", "running…"));
  d.dataset.input = JSON.stringify(input ?? {});
  d.dataset.tool = name;
  (liveGroup ?? startGroup())._parts.live.append(d);
  scroll();
  liveTool = d;
  return d;
}

const clock = () => new Date().toTimeString().slice(0, 8);

/**
 * Send a rendered view to the canvas column, and say so in the feed.
 *
 * The canvas holds ONE thing at a time on purpose. A stack of every view
 * produced this session is the log stream again, one column to the right; the
 * point of a canvas is that it shows the artifact currently being worked on.
 * Superseded views stay reachable — the feed keeps a chip that puts them back.
 */
function toCanvas(rendered, title) {
  const canvas = $("#canvas-body");
  canvas.replaceChildren(rendered);
  $("#canvas-title").textContent = title;
  $("#canvas").hidden = false;
  document.body.classList.add("split");
  return rendered;
}

// ── Run groups ───────────────────────────────────────────────────────────────
// A turn is one thing the user asked for, so a turn is one card. Sections
// accumulate into it as tools finish; catalogue calls collapse into the
// telemetry drawer instead of earning a box each.
//
// The RULES are not here — `plumbing` arrives already decided on the event, and
// the verdict on each section was computed server-side. This file arranges what
// it is told, which is the same line the renderers hold.

let liveGroup = null;

function startGroup() {
  const g = el("div", "wfgroup");
  g.dataset.plumbing = "0";
  const head = el("div", "wfhead group-head");
  const left = el("div", "wfhead-l");
  left.append(el("span", "vbadge running", "RUNNING"), el("h3", null, "Working…"));
  head.append(left, el("span", "wftime", clock()));
  const detail = el("div", "wfdetail");
  const sections = el("div", "wfsections");
  const live = el("div", "wflive");
  const drawer = el("details", "wfdrawer");
  drawer.append(el("summary", null, "▶ Developer telemetry & log"));
  const drawerBody = el("div", "wfdrawer-body");
  drawer.append(drawerBody);
  g.append(head, detail, live, sections, drawer);
  g._parts = { head, left, detail, live, sections, drawer, drawerBody, list: [], plumbing: 0 };
  $("#stream").querySelector(".empty")?.remove();
  $("#stream").append(g);
  liveGroup = g;
  scroll();
  return g;
}

/** Worst-of, mirroring VERDICT_RANK in src/views/workflow.ts. */
const VERDICT_RANK = { clear: 0, preview: 1, review: 2, hold: 3 };
const VERDICT_LABEL = { clear: "CLEAR", preview: "DRY RUN", review: "REVIEW NEEDED", hold: "HOLD" };
const REASSURING = new Set(["clear", "preview"]);

function refreshGroupHead(g, done = false) {
  const p = g._parts;
  const verdicts = p.list.map((x) => x.verdict).filter(Boolean);
  let worst = verdicts.length
    ? verdicts.reduce((w, v) => (VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w))
    : null;
  // Mirrors groupVerdict() in src/views/workflow.ts, where it is tested. CLEAR
  // and DRY RUN say nothing is wrong or nothing happened — statements about the
  // whole group — so a section with no verdict withdraws them. HOLD and REVIEW
  // propagate from one section, because those under-claim at worst.
  if (worst && REASSURING.has(worst) && p.list.some((x) => !x.verdict)) worst = null;

  const names = [...new Set(p.list.map((x) => x.title))];
  const shown = names.slice(0, 3).join(" · ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  const subjects = [...new Set(p.list.map((x) => x.subject).filter(Boolean))];
  const subject = subjects.length === 1 ? ` — ${subjects[0]}` : "";

  p.left.replaceChildren();
  if (worst) p.left.append(el("span", `vbadge ${worst}`, VERDICT_LABEL[worst]));
  // RUNNING only while the turn is live. A completed plumbing-only turn (list
  // empty, catalogue calls collapsed) kept the RUNNING badge and "Working…"
  // title forever, asserting an in-flight turn that finished; when done, it reads
  // "Catalogue search" instead.
  else if (p.list.length === 0 && !done) p.left.append(el("span", "vbadge running", "RUNNING"));
  const headline = p.list.length ? `${shown}${more}${subject}` : done ? "Catalogue search" : "Working…";
  p.left.append(el("h3", null, headline));

  const bits = [];
  if (p.list.length) bits.push(`${p.list.length} tool${p.list.length === 1 ? "" : "s"}`);
  if (p.plumbing) bits.push(`${p.plumbing} catalogue call(s) collapsed`);
  // The node is created once in startGroup and held in _parts. Looking it up
  // each refresh appended a second line every time a tool finished, so a
  // three-tool turn carried three contradictory counts stacked under its title.
  p.detail.textContent = bits.join(", ");
}

function endGroup() {
  if (!liveGroup) return;
  const p = liveGroup._parts;
  p.live.replaceChildren();
  if (p.list.length === 0 && p.plumbing === 0) liveGroup.remove();
  else refreshGroupHead(liveGroup, true);
  liveGroup = null;
}

function finishTool(summary, isError, view, toolName, plumbing) {
  const d = liveTool ?? $("#stream").querySelector(".running:last-of-type");
  const g = liveGroup ?? startGroup();
  const p = g._parts;
  const name = toolName || d?.dataset.tool || "tool";
  let input;
  try {
    input = JSON.parse(d?.dataset.input || "{}");
  } catch {
    input = {};
  }
  d?.remove();

  // Raw payloads and every intermediate call go in the drawer, always — it is
  // the record of what the model saw, and dropping it would make the transcript
  // a worse log than the one it replaced.
  if (window.toolTelemetry) p.drawerBody.append(window.toolTelemetry(name, input, summary, isError));

  if (plumbing) {
    // Collapsed, not discarded. It is in the drawer above.
    p.plumbing++;
    refreshGroupHead(g);
    scroll();
    return;
  }

  const card = view?.card;
  const section = el("div", "wfsection");
  if (card && window.workflowCard) {
    section.append(window.workflowCard(card, name, clock()));
  } else {
    const bare = el("div", "wfcard plain");
    const head = el("div", "wfhead");
    const left = el("div", "wfhead-l");
    if (isError) left.append(el("span", "vbadge hold", "FAILED"));
    left.append(el("h3", null, name));
    head.append(left, el("span", "wftime", clock()));
    bare.append(head, el("p", "wfbecause", firstLines(String(summary ?? ""))));
    section.append(bare);
  }
  p.sections.append(section);

  // The subject comes off the card as its own field. It used to be recovered
  // from the title with a regular expression, which read "CMS-1500 — CLM-88213"
  // and answered CMS-1500 — so a two-tool turn on one claim looked like two
  // claims and the group dropped the id entirely.
  p.list.push({ title: card?.title?.split(" — ")[0] || name, verdict: card?.verdict, subject: card?.subject });
  refreshGroupHead(g);

  const rendered = view && window.renderView ? window.renderView(view) : null;
  if (rendered) {
    toCanvas(rendered, card?.title || name);
    const chip = el("button", "recall", `↗ ${card?.title || name}`);
    chip.addEventListener("click", () => toCanvas(window.renderView(view), card?.title || name));
    section.append(chip);
  }

  liveTool = null;
  scroll();
}

/** First couple of lines of a tool's text, for a card with no structured view. */
function firstLines(text, max = 240) {
  const t = text.trim().split("\n").slice(0, 2).join(" ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t || "(no output)";
}

/**
 * A flagged CMS-1500 box, handed to the console as a question.
 *
 * Not an edit. The claim belongs to the model to change, through the same
 * approval gate as everything else — a form field that writes to a claim from a
 * popover would be the one path around the choke point.
 */
window.askAboutBox = (box, label, findings) => {
  show("console");
  const box$ = $("#input");
  box$.value = `Box ${box} (${label}) is flagged: ${findings.join(" ")} What is the correct value, and what does it change on the claim?`;
  box$.dispatchEvent(new Event("input"));
  box$.focus();
};

function scroll() {
  const s = $("#stream");
  s.scrollTop = s.scrollHeight;
}

// ── WebSocket ──────────────────────────────────────────────────────────

/**
 * The live-event pill. Three states, because two were a lie.
 *
 * It used to be on/off, was only ever called from the WebSocket lifecycle, and
 * so sat on its hardcoded "offline" until a session opened — meaning a freshly
 * loaded Overview, full of data the gateway had just served over HTTP, showed a
 * red dot reading OFFLINE. That is the most alarming thing on the screen and it
 * was not true of anything.
 *
 * "idle" is the honest resting state: the gateway is reachable, there is simply
 * no session streaming yet. Red is reserved for something actually being wrong.
 */
function setConn(kind, label) {
  const pill = $("#pill-conn");
  pill.innerHTML = `<span class="dot ${kind}"></span><span>${label}</span>`;
  pill.title =
    kind === "ok"
      ? "Streaming live events for this session."
      : kind === "idle"
        ? "Gateway reachable. No session is streaming — open or start one to connect."
        : "The live event stream is down. Reloading usually restores it.";
}

// Anything sent before the socket opens is queued rather than thrown away.
// Without this the FIRST message of a fresh session is lost: send() creates the
// session, connect() starts the socket, and the send lands while the socket is
// still CONNECTING — which throws InvalidStateError and drops the message
// silently, with the composer already cleared.
let outbox = [];
function wsSend(payload) {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  else outbox.push(payload);
}

function connect(sessionId) {
  state.ws?.close();
  // Only drop queued messages when switching to a DIFFERENT session. Clearing
  // unconditionally lost a message that was queued while the socket was down and
  // then reconnected to the same session — the composer had already cleared, so
  // it read as sent but was silently discarded.
  if (sessionId !== state.connectedSessionId) outbox = [];
  state.connectedSessionId = sessionId;
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws?session=${sessionId}`);
  state.ws = ws;

  // A disconnect mid-turn never delivers turn_completed, so Send stayed disabled
  // forever. Re-enable it (and clear the running flag) so the user is not frozen;
  // the turn's true outcome is unknown after a drop, and letting them retry beats
  // a dead UI.
  const onDrop = () => {
    if (state.turnRunning) {
      state.turnRunning = false;
      $("#send").disabled = false;
    }
  };

  ws.addEventListener("open", () => {
    setConn("ok", sessionId.slice(0, 16));
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    const queued = outbox;
    outbox = [];
    for (const p of queued) ws.send(JSON.stringify(p));
  });
  ws.addEventListener("close", () => {
    setConn("idle", "no session");
    onDrop();
  });
  ws.addEventListener("error", () => {
    setConn("bad", "stream error");
    onDrop();
  });

  ws.addEventListener("message", (ev) => {
    const e = JSON.parse(ev.data);
    // One seam for anything that wants to observe the stream without being
    // wired into this switch. voice.js listens here rather than wrapping the
    // socket, so the transcript layer stays a separate file that can be deleted
    // without touching the chat client.
    window.dispatchEvent(new CustomEvent("aethera:event", { detail: e }));
    switch (e.type) {
      case "turn_started":
        state.turnRunning = true;
        $("#send").disabled = true;
        liveBubble = null;
        liveGroup = null;
        break;
      case "text_delta":
        if (!liveBubble) liveBubble = addMessage("assistant", "");
        liveBubble.dataset.raw = (liveBubble.dataset.raw || "") + e.text;
        liveBubble.innerHTML = renderMarkdown(liveBubble.dataset.raw);
        scroll();
        break;
      case "tool_call":
        liveBubble = null;
        addTool(e.toolName, e.input);
        break;
      case "tool_result":
        finishTool(e.summary, e.isError, e.view, e.toolName, e.plumbing);
        break;
      case "approval_request":
        askApproval(e);
        break;
      case "approval_resolved":
        // The server resolved this request — by another client, or by the 120s
        // auto-deny timer. Without handling it, a stale modal lingered: a click
        // on it either no-op'd server-side while the UI closed as if approved, or
        // (once the next request repainted the modal in place) approved a call the
        // operator never read. Close it only if it is the one on screen.
        if (state.pendingApproval === e.approvalId) {
          state.pendingApproval = null;
          $("#approve-scrim").classList.remove("show");
        }
        break;
      case "turn_completed":
        endGroup();
        state.turnRunning = false;
        $("#send").disabled = false;
        liveBubble = null;
        loadSessions();
        break;
      case "error":
        endGroup();
        addMessage("assistant", `⚠ ${e.message}`);
        state.turnRunning = false;
        $("#send").disabled = false;
        break;
    }
  });
}

// ── Approvals ──────────────────────────────────────────────────────────

function askApproval(e) {
  state.pendingApproval = e.approvalId;
  $("#approve-why").textContent = `${e.toolName} — ${e.description || "this action needs confirmation"}`;
  $("#approve-input").textContent = JSON.stringify(e.input ?? {}, null, 2);
  $("#approve-scrim").classList.add("show");
}
function respondApproval(approved) {
  if (!state.pendingApproval) return;
  wsSend({ type: "approval_response", approvalId: state.pendingApproval, approved });
  state.pendingApproval = null;
  $("#approve-scrim").classList.remove("show");
}
$("#approve-yes").addEventListener("click", () => respondApproval(true));
$("#approve-no").addEventListener("click", () => respondApproval(false));

// ── Composer ───────────────────────────────────────────────────────────

const input = $("#input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 190)}px`;
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("#send").addEventListener("click", send);

async function send() {
  const text = input.value.trim();
  // An attachment on its own is a complete request — "here, read this" — so an
  // empty box with files pending still sends.
  if ((!text && pending.length === 0) || state.turnRunning) return;
  if (!state.sessionId) await newSession();

  const note = attachmentPreamble();
  addMessage("user", text || note.shown);
  input.value = "";
  input.style.height = "auto";
  clearAttachments();
  wsSend({ type: "user_message", sessionId: state.sessionId, text: note.forModel + text });
}

// ── Attachments ────────────────────────────────────────────────────────────
// A file is uploaded and READ the moment it is dropped, before anything is
// sent. Two reasons: the user finds out immediately that their scanned PDF
// cannot be read, rather than after a round trip through the model; and the
// identifier scan runs at the door, so "this carries a member id and its text
// is now stored" is on screen before they decide to ask anything about it.
//
// The model is told the document ID, never the content. The text is in the
// database and document_extract fetches it — pasting it into the prompt would
// send the whole EOB to the provider on every subsequent turn of the
// conversation, which is both the token cost and the disclosure nobody asked
// for.

let pending = [];

function attachmentPreamble() {
  if (pending.length === 0) return { shown: "", forModel: "" };
  const readable = pending.filter((p) => p.readable);
  const refused = pending.filter((p) => !p.readable);

  const lines = pending.map((p) =>
    p.readable
      ? `- ${p.filename} (${p.kind}, ${p.characters} characters) — document id ${p.id}`
      : `- ${p.filename} (${p.kind}) — COULD NOT BE READ: ${p.refusal}`,
  );
  const forModel =
    `[The user attached ${pending.length} file(s).]\n${lines.join("\n")}\n` +
    (readable.length
      ? `Call document_extract with a document_id to read one. The text is stored; it is not in this message.\n`
      : "") +
    (refused.length ? `The unreadable ones cannot be recovered by retrying — tell the user what to do instead.\n` : "") +
    "\n";

  return { shown: `📎 ${pending.map((p) => p.filename).join(", ")}`, forModel };
}

function clearAttachments() {
  pending = [];
  renderAttachments();
}

function renderAttachments() {
  const box = $("#attached");
  box.replaceChildren();
  box.hidden = pending.length === 0;
  for (const [i, p] of pending.entries()) {
    const chip = el("div", `chip ${p.readable ? (p.phi?.length ? "chip-phi" : "chip-ok") : "chip-bad"}`);
    chip.append(el("span", "chip-name", p.filename));
    chip.append(
      el(
        "span",
        "chip-note",
        p.uploading
          ? "reading…"
          : !p.readable
            ? "cannot be read"
            : p.phi?.length
              ? `${p.characters} chars · identifiers: ${p.phi.map((s) => s.kind).join(", ")}`
              : `${p.characters} chars`,
      ),
    );
    if (!p.uploading) {
      const x = el("button", "chip-x", "✕");
      x.title = "Remove from this message. The extracted text stays in the database — purge it with `orion documents purge`.";
      x.addEventListener("click", () => {
        pending.splice(i, 1);
        renderAttachments();
      });
      chip.append(x);
    }
    if (!p.readable && p.refusal) chip.title = p.refusal;
    box.append(chip);
  }
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  if (!state.sessionId) await newSession();

  for (const file of files) {
    const slot = { filename: file.name, uploading: true, readable: true, phi: [] };
    pending.push(slot);
    renderAttachments();
    try {
      const res = await fetch(
        `/api/upload?session=${encodeURIComponent(state.sessionId)}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file },
      );
      const out = await res.json();
      Object.assign(slot, out, { uploading: false });
      if (!res.ok) Object.assign(slot, { readable: false, refusal: out.error || `upload failed (${res.status})` });
    } catch (err) {
      Object.assign(slot, { uploading: false, readable: false, refusal: String(err) });
    }
    renderAttachments();
  }
}

$("#attach")?.addEventListener("click", () => $("#file").click());
$("#file")?.addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});

// Drop anywhere on the console. A drop target the size of a paperclip is a
// target people miss.
const consoleView = document.querySelector("#view-console");
for (const type of ["dragover", "dragenter"]) {
  consoleView?.addEventListener(type, (e) => {
    e.preventDefault();
    consoleView.classList.add("dropping");
  });
}
for (const type of ["dragleave", "drop"]) {
  consoleView?.addEventListener(type, (e) => {
    if (type === "dragleave" && consoleView.contains(e.relatedTarget)) return;
    consoleView.classList.remove("dropping");
  });
}
consoleView?.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadFiles([...(e.dataTransfer?.files ?? [])]);
});

// ── Boot ───────────────────────────────────────────────────────────────

// ── The posture banner ─────────────────────────────────────────────────────
// Shown BEFORE anyone uploads anything, which is the entire point. A prospect
// who learns this deployment will not take patient data by having a real EOB
// refused has already handed the file over; the refusal protected the database,
// not them. Saying it on load is what makes the rule a warning rather than a
// verdict.
async function loadPosture() {
  const p = await fetch("/api/posture").then((r) => r.json()).catch(() => null);
  if (!p || p.posture !== "blocked") return;
  const bar = document.createElement("div");
  bar.className = "posture-banner";
  bar.setAttribute("role", "status");
  bar.textContent = p.why;
  document.body.prepend(bar);
}

// ── "There is nowhere to put a key" ────────────────────────────────────────
// There is: the Providers & keys screen, last item in the rail. But it is the
// LAST item in a rail of eighteen, and on a deployment with no key configured
// the first thing anyone does is send a message and watch the turn fail with
// no idea where to go. A screen nobody can find is a screen that does not
// exist, so the dashboard now says so and links straight to it.
//
// Shown only when NO provider has a key. Once one is configured this is silent
// — a permanent banner is furniture, and furniture is not read.
async function loadProviderNotice() {
  const data = await fetch("/api/providers").then((r) => r.json()).catch(() => null);
  if (!data?.providers) return;
  // "ollama" counts as configured only when it has a key; a local Ollama with
  // no key is the default and is exactly the state that produces a failing
  // turn on a hosted deployment, where there is no localhost to talk to.
  if (data.providers.some((p) => p.source && p.source !== "none")) return;

  const wrap = document.querySelector("#view-overview .pad");
  if (!wrap) return;
  const bar = el("div", "banner warn");
  bar.append(
    el("b", "", "No model provider key is configured. "),
    document.createTextNode(
      "The console, the seeded claims, the KPIs and every deterministic tool work without one — " +
        "but the agent has no model to talk to, so a chat turn will fail. Add a key in ",
    ),
  );
  const link = el("span", "click link", "Providers & keys");
  link.addEventListener("click", () => show("providers"));
  bar.append(link, document.createTextNode(" (last item in the left rail)."));
  // After the title and the wordmark, before the rest of the dashboard: the
  // first thing read, which is the point.
  const anchor = wrap.querySelector(".banner");
  if (anchor) anchor.before(bar);
  else wrap.prepend(bar);
}

(async function boot() {
  await Promise.all([loadPosture(), loadOverview(), loadModules(), loadSessions(), loadProviderNotice()]);
})();

// ── Canvas controls ────────────────────────────────────────────────────
$("#canvas-close")?.addEventListener("click", () => {
  $("#canvas").hidden = true;
  document.body.classList.remove("split");
});
// The browser's own print dialog IS the PDF export. Bundling a PDF library to
// reproduce something every browser already does well would be a dependency
// earning nothing, and the print stylesheet already isolates the artifact.
$("#canvas-print")?.addEventListener("click", () => window.print());

// ── Providers & keys ───────────────────────────────────────────────────────
// Entering a key in the console rather than a terminal. The screen shows a
// MASK and nothing else: the gateway never sends a stored key back, so there is
// no value in the DOM to end up in a screenshot or a browser's memory.

async function loadProviders() {
  const data = await fetch("/api/providers").then((r) => r.json()).catch(() => null);
  if (!data) return;

  const warn = $("#prov-warnings");
  warn.replaceChildren();
  for (const w of data.warnings || []) warn.append(el("div", "banner warn", w));

  const list = $("#prov-list");
  list.replaceChildren();
  for (const p of data.providers) {
    const row = el("div", `provrow${p.active ? " active" : ""}`);

    const head = el("div", "provhead");
    head.append(el("b", null, p.name));
    if (p.active) head.append(el("span", "vbadge clear", "ACTIVE"));
    head.append(el("span", "provmodel", p.model));
    head.append(el("span", "provcap", `${p.toolCap} tools direct`));
    row.append(head);

    const state = el("div", "provstate");
    if (p.source === "env") {
      state.append(el("span", "provkey", p.masked));
      // Named explicitly: a key entered here would be silently ignored while
      // the variable is exported, and the only symptom is a 401.
      state.append(el("span", "provnote", `from ${p.envVar} — the environment wins, so a key entered here stays unused until you unset it`));
    } else if (p.source === "file") {
      state.append(el("span", "provkey", p.masked));
      state.append(el("span", "provnote", "stored on this machine"));
    } else {
      state.append(el("span", "provnote", p.name === "ollama" ? "no key needed for a local server" : "no key configured"));
    }
    row.append(state);

    const form = el("div", "provform");
    const input = el("input", "search");
    input.type = "password";
    input.placeholder = p.source === "none" ? `Paste a ${p.name} API key` : `Replace the ${p.name} key`;
    input.autocomplete = "off";
    const save = el("button", "btn sm", "Save");
    const msg = el("span", "provmsg");

    save.addEventListener("click", async () => {
      const key = input.value.trim();
      if (!key) return;
      save.disabled = true;
      const res = await fetch("/api/providers/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: p.name, key }),
      });
      const out = await res.json();
      // Cleared immediately whatever happened — a key left in an input is a key
      // in the DOM for as long as the tab is open.
      input.value = "";
      save.disabled = false;
      msg.textContent = res.ok ? `saved ${out.masked}${out.warning ? ` — ${out.warning}` : ""}` : `failed: ${out.error}`;
      if (res.ok) setTimeout(loadProviders, 900);
    });
    form.append(input, save, msg);

    if (p.source === "file") {
      const del = el("button", "btn ghost sm", "Remove");
      del.addEventListener("click", async () => {
        await fetch(`/api/providers/key/${p.name}`, { method: "DELETE" });
        loadProviders();
      });
      form.append(del);
    }
    row.append(form);

    // ── Model, endpoint, and which provider is actually active ──────────────
    // These used to require hand-editing config.json5, which meant sharing this
    // repo also meant talking somebody through a text editor. They are settings,
    // not secrets, so unlike the key they are shown and editable.
    const cfg = el("div", "provform");
    const model = el("input", "search");
    model.type = "text";
    model.value = p.name === "ollama" ? data.ollama.model : p.model;
    model.placeholder = `Model for ${p.name}`;
    model.autocomplete = "off";

    let baseUrl = null;
    let cloudModel = null;
    if (p.name === "ollama") {
      baseUrl = el("input", "search");
      baseUrl.type = "text";
      baseUrl.value = data.ollama.baseUrl || "";
      baseUrl.placeholder = "http://localhost:11434/v1";
      cloudModel = el("input", "search");
      cloudModel.type = "text";
      cloudModel.value = data.ollama.cloudModel || "";
      cloudModel.placeholder = "cloud model (used when OLLAMA_API_KEY is set)";
    }

    const apply = el("button", "btn sm", "Save settings");
    const cmsg = el("span", "provmsg");
    const postSettings = async (body, button) => {
      button.disabled = true;
      try {
        const res = await fetch("/api/providers/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const out = await res.json();
        cmsg.textContent = res.ok ? out.applied || "saved" : `failed: ${out.error}`;
        if (res.ok) setTimeout(loadProviders, 700);
      } catch (err) {
        cmsg.textContent = `failed: ${err.message}`;
      } finally {
        button.disabled = false;
      }
    };

    apply.addEventListener("click", () => {
      const body = { models: { [p.name]: model.value } };
      if (p.name === "ollama") body.ollama = { baseUrl: baseUrl.value, cloudModel: cloudModel.value };
      postSettings(body, apply);
    });

    cfg.append(model);
    if (baseUrl) cfg.append(baseUrl, cloudModel);
    cfg.append(apply);

    if (!p.active) {
      const use = el("button", "btn ghost sm", "Use this provider");
      use.addEventListener("click", () => postSettings({ provider: p.name }, use));
      cfg.append(use);
    }
    cfg.append(cmsg);
    row.append(cfg);

    list.append(row);
  }

  const foot = el("p", "sub");
  foot.textContent =
    `Keys are stored in ${data.credentialsPath} (mode 600); models and the active provider in ${data.configPath}. ` +
    "Changes apply to new sessions immediately — no restart. A conversation already open keeps the provider it started with, " +
    "so a transcript is never half one model and half another.";
  list.append(foot);
}

$("#prov-scan")?.addEventListener("click", async () => {
  const box = $("#prov-local");
  box.replaceChildren(el("p", "sub", "Scanning 127.0.0.1…"));
  const { servers } = await fetch("/api/providers/local").then((r) => r.json()).catch(() => ({ servers: [] }));
  box.replaceChildren();
  if (!servers.length) {
    box.append(el("p", "sub", "Nothing listening on the Ollama, LM Studio, llama.cpp, vLLM or text-generation-webui ports. Start one — `ollama serve` is the usual choice."));
    return;
  }
  for (const s of servers) {
    const row = el("div", "provrow");
    const head = el("div", "provhead");
    head.append(el("b", null, s.name), el("span", "provmodel", s.baseUrl));
    row.append(head);
    row.append(el("div", "provnote", s.models.length ? s.models.join(", ") : (s.note || "no models reported")));
    const cmd = el("code", "provcmd", `orion auth local --base-url ${s.baseUrl}${s.models[0] ? ` --model ${s.models[0]}` : ""}`);
    row.append(cmd);
    box.append(row);
  }
  box.append(el("p", "sub", "Run the command above, then restart the gateway. It is a CLI step because switching the active provider restarts the agent loop, and a settings screen that silently does that loses whatever turn was in flight."));
});
