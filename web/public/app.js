// AetheraClaw console. Vanilla JS, no build step.

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
}
/**
 * Domain nav items load a starter prompt into the console.
 *
 * They are not pages and do not pretend to be. Every one of these is a tool
 * that already works from the console, and a nav item opening an empty screen
 * headed "Denial Management" would be worse than one that does the thing.
 */
const DOMAIN_PROMPTS = {
  denials: "Show me the open denial worklist, sorted by what is recoverable and what is closest to a deadline.",
  money: "Run the KPI dashboard, then show me payment variance for anything underpaid.",
  em: "Check the E/M levels I have billed against the documentation, in both directions.",
  trace: "Trace claim ",
  fmea: "Diagnose the tool failures from the last 24 hours and tell me whether this is one incident or several.",
  telemetry: "Check Ollama telemetry, dataset health, and tenant database integrity.",
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
  ["Is E11.65 billable, and what does it mean?", "◈", "Coding", "Checks the NLM code set rather than recalling it — billable status comes from the hierarchy."],
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
  if (!ov) return;

  $("#pill-provider").innerHTML =
    `<span class="dot on"></span><b>${ov.model}</b>` + (ov.endpoint ? ` · ${ov.endpoint}` : "");
  $("#pill-driver").textContent = ov.driver;
  $("#foot").textContent = ov.workspace;

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
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "text" && block.text.trim()) addMessage(m.role, block.text);
      else if (block.type === "tool_use") addTool(block.name, block.input);
      else if (block.type === "tool_result") finishTool(block.content, block.isError, views[block.toolUseId]);
    }
  }
  connect(id);
  loadSessions();
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
  $("#stream").append(d);
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

function finishTool(summary, isError, view) {
  const d = liveTool ?? $("#stream").querySelector(".running:last-of-type");
  if (!d) return;
  const name = d.dataset.tool || "tool";
  let input;
  try {
    input = JSON.parse(d.dataset.input || "{}");
  } catch {
    input = {};
  }

  const card = view?.card;
  const replacement = el("div", "wfgroup");

  if (card && window.workflowCard) {
    replacement.append(window.workflowCard(card, name, clock()));
  } else {
    // No card means the server had no structured verdict for this tool — most
    // of them. A neutral header, never a green one: an invented CLEAR on a tool
    // whose output nobody parsed is the failure this whole design is avoiding.
    const bare = el("div", "wfcard plain");
    const head = el("div", "wfhead");
    const left = el("div", "wfhead-l");
    if (isError) left.append(el("span", "vbadge hold", "FAILED"));
    left.append(el("h3", null, name));
    head.append(left, el("span", "wftime", clock()));
    bare.append(head);
    bare.append(el("p", "wfbecause", firstLines(String(summary ?? ""))));
    replacement.append(bare);
  }

  if (window.toolTelemetry) replacement.append(window.toolTelemetry(name, input, summary, isError));
  d.replaceWith(replacement);

  const rendered = view && window.renderView ? window.renderView(view) : null;
  if (rendered) {
    toCanvas(rendered, card?.title || name);
    const chip = el("button", "recall", `↗ ${card?.title || name}`);
    chip.addEventListener("click", () => toCanvas(window.renderView(view), card?.title || name));
    replacement.append(chip);
  }

  liveTool = null;
  scroll();
}

/** First couple of lines of a tool's text, for a card with no structured view. */
function firstLines(text, max = 240) {
  const t = text.trim().split("\n").slice(0, 2).join(" ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t || "(no output)";
}

function scroll() {
  const s = $("#stream");
  s.scrollTop = s.scrollHeight;
}

// ── WebSocket ──────────────────────────────────────────────────────────

function setConn(on, label) {
  $("#pill-conn").innerHTML = `<span class="dot ${on ? "on" : "off"}"></span><span>${label}</span>`;
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
  outbox = [];
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws?session=${sessionId}`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setConn(true, sessionId.slice(0, 16));
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    const queued = outbox;
    outbox = [];
    for (const p of queued) ws.send(JSON.stringify(p));
  });
  ws.addEventListener("close", () => setConn(false, "offline"));
  ws.addEventListener("error", () => setConn(false, "error"));

  ws.addEventListener("message", (ev) => {
    const e = JSON.parse(ev.data);
    switch (e.type) {
      case "turn_started":
        state.turnRunning = true;
        $("#send").disabled = true;
        liveBubble = null;
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
        finishTool(e.summary, e.isError, e.view);
        break;
      case "approval_request":
        askApproval(e);
        break;
      case "turn_completed":
        state.turnRunning = false;
        $("#send").disabled = false;
        liveBubble = null;
        loadSessions();
        break;
      case "error":
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
  if (!text || state.turnRunning) return;
  if (!state.sessionId) await newSession();
  addMessage("user", text);
  input.value = "";
  input.style.height = "auto";
  wsSend({ type: "user_message", sessionId: state.sessionId, text });
}

// ── Boot ───────────────────────────────────────────────────────────────

(async function boot() {
  await Promise.all([loadOverview(), loadModules(), loadSessions()]);
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
