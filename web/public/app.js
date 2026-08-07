/* AetheraClaw web UI — vanilla JS over the shared WS protocol */
let ws = null;
let sessionId = null;
let liveAssistant = null;

const $ = (id) => document.getElementById(id);
const messages = $("messages");

async function loadSessions() {
  const rows = await (await fetch("/api/sessions")).json();
  const list = $("session-list");
  list.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.textContent = row.title || "(untitled)";
    li.dataset.id = row.id;
    if (row.id === sessionId) li.classList.add("active");
    li.onclick = () => openSession(row.id);
    list.appendChild(li);
  }
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function addToolLine(container, text, isError) {
  const line = document.createElement("div");
  line.className = "tool" + (isError ? " error" : "");
  line.textContent = text;
  container.appendChild(line);
  messages.scrollTop = messages.scrollHeight;
}

async function openSession(id) {
  sessionId = id;
  messages.innerHTML = "";
  liveAssistant = null;
  const history = await (await fetch(`/api/sessions/${id}/messages`)).json();
  for (const m of history) {
    const texts = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (texts) addMsg(m.role, texts);
    const container = messages.lastChild;
    for (const b of m.content) {
      if (b.type === "tool_use" && container) addToolLine(container, `⚙ ${b.name}`, false);
    }
  }
  connect();
  loadSessions();
}

function connect() {
  if (ws) ws.close();
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?session=${sessionId}`);
  ws.onopen = () => ($("status").textContent = `connected · ${sessionId}`);
  ws.onclose = () => ($("status").textContent = "disconnected");
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

function handleEvent(ev) {
  switch (ev.type) {
    case "turn_started":
      liveAssistant = addMsg("assistant", "");
      break;
    case "text_delta":
      if (!liveAssistant) liveAssistant = addMsg("assistant", "");
      liveAssistant.append(ev.text);
      messages.scrollTop = messages.scrollHeight;
      break;
    case "tool_call":
      if (!liveAssistant) liveAssistant = addMsg("assistant", "");
      addToolLine(liveAssistant, `⚙ ${ev.toolName}: ${JSON.stringify(ev.input).slice(0, 140)}`, false);
      break;
    case "tool_result":
      if (liveAssistant) addToolLine(liveAssistant, `↳ ${ev.isError ? "error: " : ""}${ev.summary.slice(0, 160)}`, ev.isError);
      break;
    case "approval_request":
      $("approval-desc").textContent = ev.description;
      $("approval-input").textContent = JSON.stringify(ev.input, null, 2);
      $("approval-modal").classList.remove("hidden");
      $("approve-btn").onclick = () => resolveApproval(ev.approvalId, true);
      $("deny-btn").onclick = () => resolveApproval(ev.approvalId, false);
      break;
    case "refusal":
      if (liveAssistant) addToolLine(liveAssistant, "the model declined this request", true);
      break;
    case "turn_completed":
      liveAssistant = null;
      loadSessions();
      break;
    case "error":
      addMsg("assistant", `[error: ${ev.message}]`);
      break;
  }
}

function resolveApproval(approvalId, approved) {
  ws.send(JSON.stringify({ type: "approval_response", approvalId, approved }));
  $("approval-modal").classList.add("hidden");
}

$("new-session").onclick = async () => {
  const row = await (await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  openSession(row.id);
};

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("input").value.trim();
  if (!text || !sessionId || !ws || ws.readyState !== 1) return;
  addMsg("user", text);
  ws.send(JSON.stringify({ type: "user_message", sessionId, text }));
  $("input").value = "";
};

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

loadSessions();
