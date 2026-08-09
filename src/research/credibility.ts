// ── Source credibility ──────────────────────────────────────────────────────
// In billing research the domain a sentence came from is most of its meaning.
// "Prior authorization is required for 97530" is a fact when cms.gov says it, a
// contract term when uhcprovider.com says it, and someone's recollection when a
// billing-service blog says it. Collapsing those three into "a search result"
// is how a practice ends up appealing with a citation to a vendor's marketing
// page.
//
// The security-relevant part is the matching. A naive `url.includes("cms.gov")`
// treats https://cms.gov.evil.com/ as the government, which is exactly the shape
// a spoofed policy page takes. Tiering therefore runs on the registrable domain,
// never on a substring of the URL.

export type Tier = "primary" | "payer" | "trade" | "vendor" | "unknown";

export interface TierAssessment {
  tier: Tier;
  /** 0–1. Used for ordering; not a probability of correctness. */
  score: number;
  why: string;
}

/** The rule text itself, or the body that issues it. */
const PRIMARY_DOMAINS = new Set([
  "cms.gov",
  "hhs.gov",
  "federalregister.gov",
  "govinfo.gov",
  "ecfr.gov",
  "nih.gov",
  "cdc.gov",
  "ama-assn.org",
  "x12.org",
  "wpc-edi.com",
]);

/** A payer stating its own policy — authoritative for that payer, and only that payer. */
const PAYER_DOMAINS = new Set([
  "uhc.com",
  "uhcprovider.com",
  "aetna.com",
  "cigna.com",
  "anthem.com",
  "humana.com",
  "centene.com",
  "molinahealthcare.com",
]);

/** Blue plans are one brand across dozens of registrable domains (bcbsil.com, bcbstx.com, …). */
const BCBS_DOMAIN = /^bcbs[a-z0-9-]*\.com$/;

/** Professional bodies: careful secondary reading of the rule, not the rule. */
const TRADE_DOMAINS = new Set(["aapc.com", "ahima.org", "mgma.com", "aha.org", "hfma.org", "wedi.org"]);

const COMMERCIAL_TLD = /\.(?:com|net|io|co|biz|info|ai|app|us)$/;

/**
 * Suffixes that are two labels long, so the registrable domain is three.
 * Deliberately short — this is not a public-suffix list, and it does not need to
 * be: every domain this project tiers is a US healthcare domain.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "nhs.uk", "com.au", "gov.au", "co.nz", "co.jp",
]);

/** Hostname of a URL, tolerating a missing scheme. Empty string when it is not a URL at all. */
export function hostOf(url: string): string {
  const raw = (url ?? "").trim();
  if (raw.length === 0) return "";
  for (const candidate of [raw, raw.startsWith("//") ? `https:${raw}` : `https://${raw}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname) return parsed.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      // Try the next form.
    }
  }
  return "";
}

/**
 * The domain someone had to register to serve this host.
 *
 * This is the whole defence against spoofing: www.cms.gov and mcd.cms.gov both
 * reduce to cms.gov, while cms.gov.evil.com reduces to evil.com, because only
 * the right-hand labels are ever considered.
 */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function sourceTier(url: string): TierAssessment {
  const host = hostOf(url);
  if (host.length === 0) {
    return { tier: "unknown", score: 0.2, why: `Not a URL that can be attributed to a source: "${String(url).slice(0, 80)}".` };
  }
  const domain = registrableDomain(host);

  if (PRIMARY_DOMAINS.has(domain)) {
    return { tier: "primary", score: 1, why: `${domain} publishes the rule itself — this is source text, not a summary of it.` };
  }
  if (PAYER_DOMAINS.has(domain) || BCBS_DOMAIN.test(domain)) {
    return {
      tier: "payer",
      score: 0.8,
      why: `${domain} is the payer stating its own policy — authoritative for this payer, and binding on no other.`,
    };
  }
  if (TRADE_DOMAINS.has(domain)) {
    return { tier: "trade", score: 0.6, why: `${domain} is a professional association reading the rule — well informed, still secondary.` };
  }
  if (/\.(?:gov|mil)$/.test(domain)) {
    return {
      tier: "primary",
      score: 0.9,
      why: `${domain} is a US government domain (a state Medicaid program or agency site), so it publishes its own rules directly.`,
    };
  }
  if (/\.edu$/.test(domain)) {
    return { tier: "trade", score: 0.55, why: `${domain} is an academic site — secondary, and often written for teaching rather than for billing.` };
  }
  if (COMMERCIAL_TLD.test(domain)) {
    return {
      tier: "vendor",
      score: 0.35,
      why: `${domain} is a commercial site. Vendor and blog pages restate policy from memory and go stale silently — useful for orientation, never as a citation.`,
    };
  }
  if (/\.org$/.test(domain)) {
    return { tier: "unknown", score: 0.3, why: `${domain} is an unrecognized .org — provenance cannot be established from the domain alone.` };
  }
  return { tier: "unknown", score: 0.2, why: `${domain} is not a source this recognizes.` };
}

/** Tier order used everywhere a "best first" ordering is wanted. */
export const DEFAULT_TIER_ORDER: Tier[] = ["primary", "payer", "trade", "vendor", "unknown"];

export function tierRank(tier: Tier, order: Tier[] = DEFAULT_TIER_ORDER): number {
  const at = order.indexOf(tier);
  return at === -1 ? order.length : at;
}

/**
 * A short provenance note to sit under an answer.
 *
 * States the absence as loudly as the presence: "no primary source was reached"
 * is the single most useful sentence a research answer can carry, because it
 * tells the reader the answer is somebody's summary.
 */
export function describeTiers(results: Array<{ url: string; title?: string }>): string {
  if (results.length === 0) return "No sources were read, so nothing here has provenance.";

  const byTier = new Map<Tier, string[]>();
  for (const r of results) {
    const { tier } = sourceTier(r.url);
    const host = hostOf(r.url);
    const domain = host ? registrableDomain(host) : "(unattributable)";
    const list = byTier.get(tier) ?? [];
    if (!list.includes(domain)) list.push(domain);
    byTier.set(tier, list);
  }

  const parts = DEFAULT_TIER_ORDER.filter((t) => byTier.has(t)).map((t) => {
    const domains = byTier.get(t) ?? [];
    const shown = domains.slice(0, 4).join(", ");
    return `${domains.length} ${t} (${shown}${domains.length > 4 ? ", …" : ""})`;
  });

  const lines = [`Provenance of ${results.length} source(s): ${parts.join("; ")}.`];
  if (!byTier.has("primary") && !byTier.has("payer")) {
    lines.push(
      "No primary or payer source was reached — everything above is somebody's summary of a rule, so confirm it against the rule before acting on it.",
    );
  } else if (!byTier.has("primary")) {
    lines.push("No primary (CMS/Federal Register/X12) source was reached; payer statements bind only that payer.");
  }
  return lines.join("\n");
}
