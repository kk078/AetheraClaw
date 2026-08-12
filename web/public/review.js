const queueEl = document.getElementById("queue");
const outEl = document.getElementById("out");
let items = [];

document.getElementById("load").addEventListener("click", () => {
  const raw = prompt("Paste the review queue as a JSON array of suggestions:");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [parsed];
    render();
  } catch (err) {
    alert("Could not parse that as JSON: " + err.message);
  }
});

function render() {
  if (items.length === 0) {
    queueEl.innerHTML = '<p class="empty">Nothing pending.</p>';
    return;
  }
  queueEl.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = item.id;
    const bits = [];
    if (item.confidence != null) bits.push(`confidence ${Math.round(item.confidence * 100)}%`);
    if (item.source) bits.push(`from ${item.source}`);
    if (item.claimRef || item.claim_ref) bits.push(`claim ${item.claimRef || item.claim_ref}`);
    if (item.payer) bits.push(item.payer);

    // Every dynamic value goes through textContent, never innerHTML. `provenance`
    // is text lifted VERBATIM from an uploaded document (code_suggest quotes the
    // documentation), so interpolating it into innerHTML was a stored-XSS sink:
    // a document containing `<img src=x onerror=…>` would execute on the gateway
    // origin — same origin as provider keys, every session, and stored PHI — the
    // moment a coder pasted the queue in. The static controls carry no dynamic
    // data and stay as markup.
    const meta = (text, cls = "meta") => {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      return el;
    };
    card.appendChild(meta(`${item.kind} · ${item.suggestedCode || item.suggested_code}`, "code"));
    card.appendChild(meta(item.suggestedDescription || item.suggested_description || ""));
    card.appendChild(meta(bits.join(" · ")));
    if (item.rationale) card.appendChild(meta(`Why: ${item.rationale}`));
    card.appendChild(
      item.provenance ? meta(item.provenance, "quote") : meta("⚠ No supporting documentation attached."),
    );
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML = `
      <select name="action">
        <option value="">— no decision —</option>
        <option value="accept">accept</option>
        <option value="edit">edit</option>
        <option value="reject">reject</option>
      </select>
      <input name="final" placeholder="code used" />
      <input name="reason" placeholder="reason (required to edit or reject)" />`;
    card.appendChild(actions);
    queueEl.appendChild(card);
  }
}

document.getElementById("emit").addEventListener("click", () => {
  const reviewer = document.getElementById("reviewer").value.trim();
  if (!reviewer) return alert("Enter your name — an unattributed decision is not an audit trail.");

  const calls = [];
  const problems = [];
  for (const card of queueEl.querySelectorAll(".card")) {
    const get = (name) => card.querySelector(`[name="${name}"]`).value.trim();
    const action = get("action");
    if (!action) continue;
    const reason = get("reason");
    const final = get("final");
    if ((action === "edit" || action === "reject") && !reason) {
      problems.push(`${card.dataset.id}: ${action} needs a reason.`);
      continue;
    }
    if (action === "edit" && !final) {
      problems.push(`${card.dataset.id}: edit needs the code you used instead.`);
      continue;
    }
    const call = { suggestion_id: card.dataset.id, action, reviewer };
    if (reason) call.reason = reason;
    if (action === "edit") call.final_code = final;
    calls.push(call);
  }

  if (problems.length) return alert(problems.join("\n"));
  if (calls.length === 0) return alert("No decisions to record.");

  outEl.textContent =
    "Record these with review_decide:\n\n" + calls.map((c) => JSON.stringify(c, null, 2)).join("\n");
  outEl.hidden = false;
});
