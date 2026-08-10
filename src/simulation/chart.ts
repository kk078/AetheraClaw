import type { PracticeModel } from "./model.js";
import type { Forecast } from "./monte-carlo.js";

// ── Fan chart ────────────────────────────────────────────────────────────────
// A forecast drawn as a single line is a lie told with a pen. The band is the
// finding — it widens with the horizon because the further out you look the
// less you know, and a picture that shows that is doing more work than one that
// shows a confident trajectory through the middle of it.
//
// Inline SVG, computed here rather than in the browser: the page has no script,
// no chart library and no network dependency, so it opens from a file and keeps
// working in five years.

const W = 900;
const H = 380;
const PAD = { top: 24, right: 24, bottom: 44, left: 76 };

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function money(x: number): string {
  if (Math.abs(x) >= 1000) return `$${Math.round(x / 1000)}k`;
  return `$${Math.round(x)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function fanChartSvg(f: Forecast): string {
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxY = niceCeiling(Math.max(1, ...f.total.map((b) => b.p90)));

  const x = (day: number) => PAD.left + (day / Math.max(1, f.horizonDays)) * plotW;
  const y = (value: number) => PAD.top + plotH - (value / maxY) * plotH;

  const upper = f.total.map((b) => `${x(b.day).toFixed(1)},${y(b.p90).toFixed(1)}`).join(" ");
  const lower = [...f.total].reverse().map((b) => `${x(b.day).toFixed(1)},${y(b.p10).toFixed(1)}`).join(" ");
  const median = f.total.map((b) => `${x(b.day).toFixed(1)},${y(b.p50).toFixed(1)}`).join(" ");
  const insurance = f.insurance.map((b) => `${x(b.day).toFixed(1)},${y(b.p50).toFixed(1)}`).join(" ");

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const value = maxY * t;
    return `<line x1="${PAD.left}" y1="${y(value).toFixed(1)}" x2="${W - PAD.right}" y2="${y(value).toFixed(1)}" class="grid" />
      <text x="${PAD.left - 10}" y="${(y(value) + 4).toFixed(1)}" class="tick" text-anchor="end">${money(value)}</text>`;
  });

  const step = f.horizonDays <= 120 ? 30 : f.horizonDays <= 400 ? 90 : 180;
  const xTicks: string[] = [];
  for (let d = 0; d <= f.horizonDays; d += step) {
    xTicks.push(
      `<text x="${x(d).toFixed(1)}" y="${H - PAD.bottom + 20}" class="tick" text-anchor="middle">day ${d}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cash forecast with a P10 to P90 band">
    ${yTicks.join("\n")}
    <polygon points="${upper} ${lower}" class="band" />
    <polyline points="${median}" class="median" fill="none" />
    <polyline points="${insurance}" class="insurance" fill="none" />
    ${xTicks.join("\n")}
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" class="axis" />
    <line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" class="axis" />
  </svg>`;
}

export function renderFanChart(f: Forecast, model: PracticeModel): string {
  const marks = [30, 60, 90, 180, 365].filter((d) => d <= f.horizonDays);
  if (!marks.includes(f.horizonDays)) marks.push(f.horizonDays);

  const rows = marks
    .map(
      (d) => `<tr>
        <td>Day ${d}</td>
        <td class="num">$${Math.round(f.insurance[d].p50).toLocaleString("en-US")}</td>
        <td class="num">$${Math.round(f.patient[d].p50).toLocaleString("en-US")}</td>
        <td class="num strong">$${Math.round(f.total[d].p50).toLocaleString("en-US")}</td>
        <td class="num muted">$${Math.round(f.total[d].p10).toLocaleString("en-US")} – $${Math.round(f.total[d].p90).toLocaleString("en-US")}</td>
      </tr>`,
    )
    .join("\n");

  const warnings = f.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("\n");
  const modelWarnings = model.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cash forecast — Orion</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --line: #e5e7eb;
    --band: rgba(37, 99, 235, 0.18); --median: #2563eb; --insurance: #059669; --accent: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --fg: #e8e8ea; --muted: #9ca3af; --line: #262b33;
      --band: rgba(96, 165, 250, 0.22); --median: #60a5fa; --insurance: #34d399; --accent: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 940px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; }
  .chart { overflow-x: auto; }
  svg { display: block; width: 100%; min-width: 620px; height: auto; }
  .band { fill: var(--band); }
  .median { stroke: var(--median); stroke-width: 2.5; }
  .insurance { stroke: var(--insurance); stroke-width: 1.5; stroke-dasharray: 5 4; }
  .grid { stroke: var(--line); stroke-width: 1; }
  .axis { stroke: var(--muted); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; }
  .legend { display: flex; gap: 1.5rem; flex-wrap: wrap; color: var(--muted); font-size: .85rem; margin-top: .5rem; }
  .swatch { display: inline-block; width: 22px; height: 3px; vertical-align: middle; margin-right: .4rem; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .strong { font-weight: 600; }
  .muted { color: var(--muted); }
  ul { padding-left: 1.2rem; }
  li { margin: .4rem 0; color: var(--muted); }
  .caveat { border-left: 3px solid var(--accent); padding: .75rem 1rem; margin-top: 1rem; background: color-mix(in srgb, var(--accent) 7%, transparent); }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .8rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(f.scenario.label)}</h1>
  <p class="sub">${f.horizonDays}-day cumulative cash · ${f.paths} simulated paths · seed ${f.seed}</p>

  <div class="chart">${fanChartSvg(f)}</div>
  <div class="legend">
    <span><span class="swatch" style="background:var(--median)"></span>Total, median</span>
    <span><span class="swatch" style="background:var(--insurance)"></span>Insurance only</span>
    <span><span class="swatch" style="background:var(--band);height:12px"></span>P10 – P90</span>
  </div>

  <h2>Milestones</h2>
  <table>
    <thead><tr><th>Horizon</th><th class="num">Insurance</th><th class="num">Patient</th><th class="num">Total</th><th class="num">Range</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="caveat">
    <strong>The band is the finding, not the line.</strong> It widens because the further out you look the less
    the history can tell you. It covers per-claim timing, denials and a per-payer shock — not a clearinghouse
    outage, not a payer taking three weeks off, not a bad quarter across the whole book. Read it as a floor on
    uncertainty rather than a range.
  </div>

  <h2>What this forecast does not cover</h2>
  <ul>${warnings}</ul>

  ${modelWarnings ? `<h2>What the underlying model does not know</h2>\n  <ul>${modelWarnings}</ul>` : ""}

  <footer>
    Fitted from ${model.totalClaims} claim(s), ${model.resolvedClaims} adjudicated, over ${model.observedDays} day(s).
    Outstanding claims are carried into the timing fit as censored observations rather than dropped —
    fitting only from claims that have paid fits only the fast ones.
    Generated by Orion. Synthetic and de-identified data only.
  </footer>
</main>
</body>
</html>
`;
}
