const lines = document.getElementById("lines");
const out = document.getElementById("out");
const copyBtn = document.getElementById("copy");

function addLine() {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input name="code" required /></td>
    <td><input name="modifiers" placeholder="25" /></td>
    <td><input name="charge" type="number" step="0.01" min="0" required /></td>
    <td><input name="units" type="number" min="1" value="1" /></td>
    <td><input name="service_date" pattern="\\d{8}" required /></td>
    <td><input name="place_of_service" value="11" /></td>
    <td><input name="diagnoses" placeholder="E11.65, M17.11" required /></td>
    <td><button type="button" class="remove">×</button></td>`;
  tr.querySelector(".remove").addEventListener("click", () => tr.remove());
  lines.appendChild(tr);
}
document.getElementById("add-line").addEventListener("click", addLine);
addLine();

const csv = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

document.getElementById("sb-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const claim = {
    claim_id: form.get("claim_id"),
    payer_name: form.get("payer_name"),
    payer_id: form.get("payer_id"),
    billing_provider_npi: form.get("billing_provider_npi"),
    billing_provider_name: form.get("billing_provider_name"),
    subscriber_id: form.get("subscriber_id"),
    patient_last: form.get("patient_last"),
    patient_first: form.get("patient_first"),
    patient_dob: form.get("patient_dob"),
    patient_sex: (form.get("patient_sex") || "U").toUpperCase(),
    encounter_diagnoses: csv(form.get("encounter_diagnoses") || ""),
    lines: [...lines.querySelectorAll("tr")].map((tr) => {
      const get = (name) => tr.querySelector(`[name="${name}"]`).value;
      const line = {
        code: get("code").toUpperCase(),
        charge: Number(get("charge")),
        units: Number(get("units") || 1),
        service_date: get("service_date"),
        place_of_service: get("place_of_service") || "11",
        diagnoses: csv(get("diagnoses")),
      };
      const modifiers = csv(get("modifiers"));
      if (modifiers.length) line.modifiers = modifiers;
      return line;
    }),
  };
  const rendering = form.get("rendering_provider_npi");
  if (rendering) claim.rendering_provider_npi = rendering;

  out.textContent =
    "Paste this into chat and ask for superbill_build, then claim_scrub:\n\n" + JSON.stringify(claim, null, 2);
  out.hidden = false;
  copyBtn.hidden = false;
});

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(out.textContent.split("\n\n").slice(1).join("\n\n"));
  copyBtn.textContent = "Copied";
  setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
});
