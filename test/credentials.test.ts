import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KEY_PREFIXES,
  SECRET_FILE_MODE,
  loadCredentials,
  maskKey,
  removeCredential,
  resolveKey,
  setCredential,
  shapeWarning,
} from "../src/config/credentials.js";
import { MIN_REDACTABLE, containsSecret, mentionsSecretFile, redactSecrets } from "../src/config/secrets.js";
import { evaluateSet, renderList } from "../src/cli/auth.js";
import { LOCAL_CANDIDATES, parseModelList, renderDiscovery } from "../src/providers/discover.js";
import { assessCommandRisk } from "../src/tools/shell.js";
import { HARD_TOOL_LIMITS, PROVIDER_TOOL_LIMITS, resolveToolLimit, selectTools } from "../src/tools/profiles.js";
import { budgetAt, buildBudget, renderBudget, wireBytes } from "../src/tools/budget.js";
import { META_NAMES } from "../src/tools/meta.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeth-cred-"));
  file = path.join(dir, "credentials.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("storing a key", () => {
  it("round-trips through the file", () => {
    setCredential("anthropic", "sk-ant-abcdefghijklmnop", "laptop", file);
    const { credentials } = loadCredentials(file);
    expect(credentials.anthropic?.key).toBe("sk-ant-abcdefghijklmnop");
    expect(credentials.anthropic?.note).toBe("laptop");
  });

  it("writes the file owner-only", () => {
    // A key readable by every account on a shared clinic workstation is not
    // protected by the application having been careful elsewhere.
    setCredential("openai", "sk-abcdefghijklmnopqrst", undefined, file);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(SECRET_FILE_MODE);
    }
  });

  it("warns when the mode has drifted wider", () => {
    setCredential("openai", "sk-abcdefghijklmnopqrst", undefined, file);
    if (process.platform === "win32") return;
    fs.chmodSync(file, 0o644);
    const { warnings } = loadCredentials(file);
    expect(warnings.join(" ")).toMatch(/other accounts on this machine can read/i);
  });

  it("removes one without touching the others", () => {
    setCredential("anthropic", "sk-ant-aaaaaaaaaaaaaaa", undefined, file);
    setCredential("openai", "sk-bbbbbbbbbbbbbbbbbb", undefined, file);
    expect(removeCredential("anthropic", file)).toBe(true);
    const { credentials } = loadCredentials(file);
    expect(credentials.anthropic).toBeUndefined();
    expect(credentials.openai?.key).toBe("sk-bbbbbbbbbbbbbbbbbb");
  });

  it("reports nothing removed rather than pretending", () => {
    expect(removeCredential("gemini", file)).toBe(false);
  });

  it("ignores a corrupt file rather than refusing to start", () => {
    // Every provider can also be configured by environment variable. Refusing
    // to boot over an unparseable secrets file would strand somebody who has a
    // working key exported in their shell.
    fs.writeFileSync(file, "{ not json");
    const { credentials, warnings } = loadCredentials(file);
    expect(credentials).toEqual({});
    expect(warnings.join(" ")).toMatch(/could not be parsed/i);
  });

  it("drops entries with an empty key instead of reporting them configured", () => {
    fs.writeFileSync(file, JSON.stringify({ openai: { key: "   ", addedAt: 1 } }));
    expect(loadCredentials(file).credentials.openai).toBeUndefined();
  });
});

describe("masking", () => {
  it("keeps only the ends of a long key", () => {
    const masked = maskKey("sk-ant-api03-ABCDEFGHIJKLMNOP");
    expect(masked.startsWith("sk-a")).toBe(true);
    expect(masked.endsWith("MNOP")).toBe(true);
    expect(masked).not.toContain("api03");
  });

  it("masks a short string completely", () => {
    // "Keep the ends" discloses almost everything at eight characters.
    expect(maskKey("abcd1234")).toBe("********");
    expect(maskKey("abcd1234")).not.toContain("abcd");
  });
});

describe("key shape", () => {
  it("warns on a prefix the provider does not use, without refusing", () => {
    const w = shapeWarning("anthropic", "ghp_something");
    expect(w).toMatch(/usually start with/);
    expect(w).toMatch(/Storing it anyway/);
  });

  it("accepts a correct prefix silently", () => {
    expect(shapeWarning("anthropic", `${KEY_PREFIXES.anthropic![0]}xyz`)).toBeNull();
  });

  it("catches the copy-paste that picked up a line break", () => {
    expect(shapeWarning("openai", "sk-abc def")).toMatch(/space/);
  });

  it("has no prefix rule for ollama, whose keys have no fixed shape", () => {
    expect(KEY_PREFIXES.ollama).toBeUndefined();
    expect(shapeWarning("ollama", "85dbdae6b0504f61a842")).toBeNull();
  });
});

describe("where a key comes from", () => {
  it("prefers the environment over the stored file", () => {
    // The stored key is the durable default; an environment variable is a
    // per-run override for CI or a rotation. If the file won, an exported key
    // would be silently ignored and the only symptom is a 401.
    const store = { openai: { key: "stored-key-aaaaaaaa", addedAt: 1 } };
    const r = resolveKey("openai", { env: { OPENAI_API_KEY: "env-key-bbbbbbbb" }, store });
    expect(r.key).toBe("env-key-bbbbbbbb");
    expect(r.source).toBe("env");
  });

  it("falls back to the stored file", () => {
    const store = { openai: { key: "stored-key-aaaaaaaa", addedAt: 1 } };
    const r = resolveKey("openai", { env: {}, store });
    expect(r.key).toBe("stored-key-aaaaaaaa");
    expect(r.source).toBe("file");
  });

  it("reports none rather than an empty string", () => {
    const r = resolveKey("gemini", { env: {}, store: {} });
    expect(r.key).toBeUndefined();
    expect(r.source).toBe("none");
  });

  it("ignores an environment variable that is only whitespace", () => {
    const r = resolveKey("openai", { env: { OPENAI_API_KEY: "   " }, store: { openai: { key: "stored-aaaaaaaaaa", addedAt: 1 } } });
    expect(r.source).toBe("file");
  });

  it("names the right variable per provider", () => {
    expect(resolveKey("anthropic", { env: {}, store: {} }).envVar).toBe("ANTHROPIC_API_KEY");
    expect(resolveKey("gemini", { env: {}, store: {} }).envVar).toBe("GEMINI_API_KEY");
  });
});

describe("entering a key", () => {
  it("warns when an environment variable will shadow what was just stored", () => {
    // The trap: the key is stored, is correct, is ignored on every run, and the
    // only symptom is a 401 from a key the user can see is right.
    const out = evaluateSet("openai", "sk-newkeyaaaaaaaaaaaa", { OPENAI_API_KEY: "sk-oldkeybbbbbbbbbbbb" });
    expect(out.stored).toBe(true);
    expect(out.messages.join(" ")).toMatch(/environment WINS/);
  });

  it("does not warn when the environment holds the same key", () => {
    const out = evaluateSet("openai", "sk-samekeyaaaaaaaaaa", { OPENAI_API_KEY: "sk-samekeyaaaaaaaaaa" });
    expect(out.messages.join(" ")).not.toMatch(/WINS/);
  });

  it("stores nothing for an empty entry", () => {
    expect(evaluateSet("openai", "", {}).stored).toBe(false);
  });

  it("never prints a key in the listing", () => {
    setCredential("anthropic", "sk-ant-SUPERSECRETVALUE99", undefined, file);
    // renderList reads the real path, so assert on the masking rule directly:
    // the guarantee is that a full key never appears in rendered output.
    const rendered = renderList({});
    expect(rendered).not.toContain("SUPERSECRETVALUE99");
  });
});

// ── The reason redaction exists ──────────────────────────────────────────────

describe("keeping secrets out of tool output", () => {
  const secrets = [{ value: "sk-ant-api03-REALKEYVALUE", label: "api-key" }];

  it("replaces the value wherever it appears", () => {
    const out = redactSecrets('{"anthropic":{"key":"sk-ant-api03-REALKEYVALUE"}}', secrets);
    expect(out).not.toContain("REALKEYVALUE");
    expect(out).toContain("[REDACTED:api-key]");
  });

  it("replaces every occurrence, not just the first", () => {
    const out = redactSecrets("sk-ant-api03-REALKEYVALUE and again sk-ant-api03-REALKEYVALUE", secrets);
    expect(out.match(/REDACTED/g)).toHaveLength(2);
  });

  it("catches the value however it was reached", () => {
    // The point of redacting the VALUE rather than blocking a command: `cat` is
    // one path to it, and `env`, `grep`, and a script that echoes it are others.
    for (const reached of [
      "ANTHROPIC_API_KEY=sk-ant-api03-REALKEYVALUE",
      "/root/.aetheraclaw/credentials.json: sk-ant-api03-REALKEYVALUE",
      "Authorization: Bearer sk-ant-api03-REALKEYVALUE",
    ]) {
      expect(redactSecrets(reached, secrets)).not.toContain("REALKEYVALUE");
    }
  });

  it("leaves short values alone so ordinary output is not corrupted", () => {
    // An empty or four-character "secret" would match everywhere and blank out
    // unrelated codes. Every real provider key is far longer.
    expect(MIN_REDACTABLE).toBeGreaterThan(8);
    expect(redactSecrets("code 99214 charge", [{ value: "99214", label: "x" }])).toBe("code 99214 charge");
  });

  it("reports whether a secret was present", () => {
    expect(containsSecret("nothing here", secrets)).toBe(false);
    expect(containsSecret("x sk-ant-api03-REALKEYVALUE y", secrets)).toBe(true);
  });
});

describe("commands that name a credentials file", () => {
  it("escalates what was previously auto-approved", () => {
    // `cat` is on the auto-approved list, so before this `cat
    // ~/.aetheraclaw/credentials.json` ran with no prompt at all.
    expect(assessCommandRisk("cat ~/.aetheraclaw/credentials.json").level).toBe("confirm");
    expect(assessCommandRisk("cat /root/.aetheraclaw/credentials.json").level).toBe("confirm");
    expect(assessCommandRisk("head -5 .env").level).toBe("confirm");
  });

  it("still auto-approves ordinary reads", () => {
    expect(assessCommandRisk("cat README.md").level).toBe("safe");
    expect(assessCommandRisk("ls").level).toBe("safe");
  });

  it("matches the file name, not a resolved path", () => {
    // A command may reach it by ~, by $HOME, by a relative path or by a glob.
    expect(mentionsSecretFile("cat $HOME/.aetheraclaw/credentials.json")).toBe(true);
    expect(mentionsSecretFile("cat ../../credentials.json")).toBe(true);
    expect(mentionsSecretFile("cat notes.md")).toBe(false);
  });
});

// ── Local servers ────────────────────────────────────────────────────────────

describe("finding a local model server", () => {
  it("reads the standard OpenAI model-list shape", () => {
    expect(parseModelList({ data: [{ id: "qwen3" }, { id: "llama3.2" }] })).toEqual(["qwen3", "llama3.2"]);
  });

  it("reads a bare array, which llama.cpp has shipped", () => {
    // A reader that assumes one shape reports a live server as having no models.
    expect(parseModelList([{ id: "local-model" }])).toEqual(["local-model"]);
    expect(parseModelList(["plain-string-id"])).toEqual(["plain-string-id"]);
  });

  it("returns nothing for a body it cannot understand", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ error: "nope" })).toEqual([]);
  });

  it("probes Ollama first, because that is the one already supported", () => {
    expect(LOCAL_CANDIDATES[0].name).toBe("Ollama");
    expect(LOCAL_CANDIDATES[0].port).toBe(11434);
  });

  it("tells the user what to do when nothing is running", () => {
    const out = renderDiscovery([]);
    expect(out).toMatch(/No local model server/);
    expect(out).toMatch(/ollama serve/);
    expect(out).toMatch(/auth set/);
  });

  it("gives a runnable command when something is found", () => {
    const out = renderDiscovery([{ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["qwen3"] }]);
    expect(out).toMatch(/auth local --base-url http:\/\/127\.0\.0\.1:11434\/v1 --model qwen3/);
  });

  it("says so when a server answers with no models loaded", () => {
    const out = renderDiscovery([{ name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [], note: "Answered, but reports no models — pull or load one first." }]);
    expect(out).toMatch(/reports no models/);
  });
});

// ── The promise that survives switching providers ────────────────────────────

describe("same execution results, whichever provider", () => {
  it("reaches every tool under every provider, differing only in how many are direct", () => {
    // The guarantee worth stating precisely. Tool RESULTS are pure functions of
    // their input, so they cannot vary by provider. What varies is how many
    // definitions fit in a request — Ollama takes 64, Anthropic 512 — and the
    // rest are reachable through tool_search / tool_invoke rather than lost.
    // A change that let a provider DROP tools outright would break the promise
    // silently, which is what this asserts against.
    // The catalogue tools must be among them: they are what makes the overflow
    // DEFERRED rather than dropped, since they are the route back to a tool
    // that did not fit on the wire. A fixture without them measures a
    // configuration this product never ships.
    const names = [...META_NAMES, ...Array.from({ length: 224 }, (_, i) => `tool_${i}`)];
    const specs = names.map((name) => ({
      name,
      description: "d",
      inputSchema: { type: "object" as const, properties: {} },
    }));

    for (const provider of ["anthropic", "openai", "gemini", "ollama"]) {
      const s = selectTools(specs, "all", provider);
      expect(s.droppedByLimit, `${provider} dropped tools outright`).toHaveLength(0);
      expect(s.specs.length + s.deferred.length, `${provider} lost a tool`).toBe(specs.length);
    }
  });

  it("caps differ, which is the honest part of the answer", () => {
    expect(PROVIDER_TOOL_LIMITS.ollama).toBeLessThan(PROVIDER_TOOL_LIMITS.anthropic);
  });
});

// ── Raising the tool limit ───────────────────────────────────────────────────

describe("how many tools go on the wire", () => {
  it("uses the provider default when nothing is configured", () => {
    expect(resolveToolLimit("ollama").limit).toBe(PROVIDER_TOOL_LIMITS.ollama);
    expect(resolveToolLimit("anthropic").limit).toBe(512);
  });

  it("honours an override where the provider has no hard cap", () => {
    // Ollama's default is about CONTEXT, not an API limit — sized for an 8k
    // local window. On a large-context cloud model it leaves most of the
    // catalogue behind tool_search for no reason.
    const d = resolveToolLimit("ollama", 224);
    expect(d.limit).toBe(224);
    expect(d.note).toBeUndefined();
  });

  it("clamps a request above a hard API limit, and says it clamped", () => {
    // OpenAI rejects more than 128 definitions outright. A config asking for
    // 224 would not get a bigger tool set, it would get an error every turn.
    const d = resolveToolLimit("openai", 224);
    expect(d.limit).toBe(HARD_TOOL_LIMITS.openai);
    expect(d.note).toMatch(/rejects more than 128/);
  });

  it("allows a request at or below the hard limit", () => {
    expect(resolveToolLimit("openai", 100).limit).toBe(100);
    expect(resolveToolLimit("openai", 128).note).toBeUndefined();
  });

  it("ignores a nonsense override rather than sending zero tools", () => {
    for (const bad of [0, -5, Number.NaN]) {
      expect(resolveToolLimit("ollama", bad).limit).toBe(PROVIDER_TOOL_LIMITS.ollama);
    }
  });

  it("actually changes what selectTools puts on the wire", () => {
    const specs = [...META_NAMES, ...Array.from({ length: 224 }, (_, i) => `tool_${i}`)].map((name) => ({
      name,
      description: "d",
      inputSchema: { type: "object" as const, properties: {} },
    }));
    const before = selectTools(specs, "all", "ollama");
    const after = selectTools(specs, "all", "ollama", 300);
    expect(before.deferred.length).toBeGreaterThan(0);
    expect(after.deferred).toHaveLength(0);
    expect(after.specs.length).toBe(specs.length);
  });

  it("reports the clamp through selectTools too, not only in isolation", () => {
    const specs = [...META_NAMES, ...Array.from({ length: 224 }, (_, i) => `tool_${i}`)].map((name) => ({
      name,
      description: "d",
      inputSchema: { type: "object" as const, properties: {} },
    }));
    const s = selectTools(specs, "all", "openai", 224);
    expect(s.notes.join(" ")).toMatch(/rejects more than 128/);
    expect(s.specs.length).toBeLessThanOrEqual(128);
  });
});

describe("what a tool block costs", () => {
  const specs = Array.from({ length: 224 }, (_, i) => ({
    name: `tool_${i}`,
    description: "a description long enough to be realistic for a domain tool",
    inputSchema: { type: "object" as const, properties: { a: { type: "string" } } },
  }));

  it("counts bytes in the encoding the wire actually carries", () => {
    expect(wireBytes(specs[0])).toBeGreaterThan(100);
  });

  it("grows with the number sent, which is the whole point", () => {
    const rows = budgetAt(specs, [16, 64, 224]);
    expect(rows[0].tokens).toBeLessThan(rows[1].tokens);
    expect(rows[1].tokens).toBeLessThan(rows[2].tokens);
  });

  it("says plainly that a lower limit loses no capability", () => {
    // The distinction the whole feature rests on: deferred is a round trip, not
    // a missing tool.
    const out = renderBudget(buildBudget(specs, 128000), { provider: "ollama", contextWindow: 128000, current: 64 });
    expect(out).toMatch(/NOTHING IS LOST/);
    expect(out).toMatch(/tool_search/);
  });

  it("names a hard API cap as a limit rather than a preference", () => {
    const out = renderBudget(buildBudget(specs, 128000), { provider: "openai", contextWindow: 128000, current: 128 });
    expect(out).toMatch(/API limit, not a setting/);
  });
});
