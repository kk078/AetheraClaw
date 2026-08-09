import { describe, expect, it } from "vitest";
import {
  BrowserSpeechProvider,
  CloudSpeechProvider,
  KNOWN_SPEECH_ENGINES,
  LocalSpeechProvider,
  createSpeechProvider,
  speechStatus,
} from "../src/speech/providers/index.js";
import {
  buildDeepgramTranscribeRequest,
  buildElevenLabsSpeechRequest,
  buildOpenAiSpeechRequest,
  buildOpenAiTranscribeRequest,
  describeSpeechRequest,
  extensionForMime,
  isRequestError,
  parseTranscriptResponse,
  type SpeechHttpRequest,
} from "../src/speech/providers/cloud.js";
import {
  buildPiperArgs,
  buildWhisperArgs,
  checkPiperPrereqs,
  checkWhisperPrereqs,
  outputPrefix,
  parseWhisperOutput,
  resolveBinary,
} from "../src/speech/providers/local.js";
import type { SpeechConfig, SpeechEnv } from "../src/speech/providers/types.js";

// A fake key that is easy to grep for. Every "no secret leaks" assertion below
// looks for exactly this string.
const FAKE_STT_KEY = "sk-test-STTSECRETVALUE-0123456789";
const FAKE_TTS_KEY = "el-test-TTSSECRETVALUE-9876543210";

function config(over: Partial<SpeechConfig> = {}): SpeechConfig {
  return {
    enabled: true,
    engine: "local",
    mode: "push-to-talk",
    wakeWord: "hey claw",
    speakReplies: true,
    maxSpokenChars: 600,
    local: {
      whisperBin: "/opt/whisper/whisper-cli",
      whisperModel: "/opt/whisper/models/ggml-base.en.bin",
      piperBin: "/opt/piper/piper",
      piperVoice: "/opt/piper/voices/en_US-amy-medium.onnx",
    },
    cloud: {
      sttVendor: "openai",
      ttsVendor: "openai",
      sttModel: "whisper-1",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      sttKeyEnv: "SPEECH_STT_KEY",
      ttsKeyEnv: "SPEECH_TTS_KEY",
    },
    consent: { requireAcknowledgement: true, retainAudio: false },
    ...over,
  };
}

const withKeys: SpeechEnv = { SPEECH_STT_KEY: FAKE_STT_KEY, SPEECH_TTS_KEY: FAKE_TTS_KEY, PATH: "/usr/bin:/bin" };
const withoutKeys: SpeechEnv = { PATH: "/usr/bin:/bin" };

/** Every path in this suite is checked against a filesystem that has nothing. */
const nothingExists = () => false;
const everythingExists = () => true;

// ── The factory ──────────────────────────────────────────────────────────────

describe("createSpeechProvider", () => {
  it("returns the browser descriptor for engine browser", () => {
    const provider = createSpeechProvider(config({ engine: "browser" }), withoutKeys);
    expect(provider).toBeInstanceOf(BrowserSpeechProvider);
    expect(provider.name).toBe("browser");
    expect(provider.runsInBrowser).toBe(true);
  });

  it("returns the local adapter for engine local", () => {
    const provider = createSpeechProvider(config({ engine: "local" }), withoutKeys);
    expect(provider).toBeInstanceOf(LocalSpeechProvider);
    expect(provider.name).toBe("local");
    expect(provider.runsInBrowser).toBe(false);
  });

  it("returns the cloud adapter for engine cloud", () => {
    const provider = createSpeechProvider(config({ engine: "cloud" }), withKeys);
    expect(provider).toBeInstanceOf(CloudSpeechProvider);
    expect(provider.name).toBe("cloud");
    expect(provider.runsInBrowser).toBe(false);
  });

  it("throws a named error for an engine it does not know", () => {
    // A hand-edited config or a websocket message can carry anything; the value
    // must appear in the message, and so must the valid set.
    const bad = config({ engine: "whisper-cloud-9000" as SpeechConfig["engine"] });
    expect(() => createSpeechProvider(bad, withoutKeys)).toThrow(/unknown speech engine "whisper-cloud-9000"/);
    expect(() => createSpeechProvider(bad, withoutKeys)).toThrow(/browser, local, cloud/);
    expect(KNOWN_SPEECH_ENGINES).toEqual(["browser", "local", "cloud"]);
  });

  it("covers every known engine — the factory and the list cannot drift apart", () => {
    for (const engine of KNOWN_SPEECH_ENGINES) {
      expect(() => createSpeechProvider(config({ engine }), withKeys)).not.toThrow();
    }
  });
});

// ── whisper.cpp argv ─────────────────────────────────────────────────────────

describe("buildWhisperArgs", () => {
  const cfg = config().local;

  it("names the model, the input file and the output prefix, field by field", () => {
    const args = buildWhisperArgs(cfg, "/tmp/aetheraclaw-stt-x/input.wav");
    expect(args).toEqual([
      "-m",
      "/opt/whisper/models/ggml-base.en.bin",
      "-f",
      "/tmp/aetheraclaw-stt-x/input.wav",
      "--output-txt",
      "--no-timestamps",
      "--output-file",
      "/tmp/aetheraclaw-stt-x/input",
      "--print-progress",
      "false",
    ]);
  });

  it("keeps the output prefix in step with the input so cleanup can find the sidecar", () => {
    expect(outputPrefix("/tmp/dir.d/input.webm")).toBe("/tmp/dir.d/input");
    const args = buildWhisperArgs(cfg, "/tmp/dir.d/input.webm");
    expect(args[args.indexOf("--output-file") + 1]).toBe("/tmp/dir.d/input");
  });

  it("never puts audio or a transcript on the command line", () => {
    // argv is readable by every process on the host via `ps`; PHI belongs in a
    // file, not in the process table.
    const args = buildWhisperArgs(cfg, "/tmp/x/input.wav");
    expect(args.join(" ")).not.toMatch(/patient|member/i);
    expect(args).toContain("-f");
  });
});

describe("buildPiperArgs", () => {
  it("passes only the voice model and the output path", () => {
    expect(buildPiperArgs(config().local, "/tmp/tts/speech.wav")).toEqual([
      "--model",
      "/opt/piper/voices/en_US-amy-medium.onnx",
      "--output_file",
      "/tmp/tts/speech.wav",
    ]);
  });

  it("keeps the spoken text off argv — Piper reads it from stdin", () => {
    const args = buildPiperArgs(config().local, "/tmp/tts/speech.wav");
    expect(args.join(" ")).not.toContain("Jane Doe");
    expect(args).not.toContain("--text");
  });
});

// ── whisper output parsing ───────────────────────────────────────────────────

describe("parseWhisperOutput", () => {
  it("strips timestamp brackets from real-shaped whisper output", () => {
    const raw = [
      "[00:00:00.000 --> 00:00:03.200]   Calling about claim number 4429.",
      "[00:00:03.200 --> 00:00:06.480]   It was denied for missing prior authorization.",
      "",
    ].join("\n");
    expect(parseWhisperOutput(raw)).toBe(
      "Calling about claim number 4429. It was denied for missing prior authorization.",
    );
  });

  it("drops [BLANK_AUDIO] and the other non-speech markers entirely", () => {
    const raw = [
      "[00:00:00.000 --> 00:00:05.000]   [BLANK_AUDIO]",
      "[00:00:05.000 --> 00:00:07.000]   (silence)",
      "[00:00:07.000 --> 00:00:09.500]   [MUSIC]",
      "[00:00:09.500 --> 00:00:11.000]   Okay, go ahead.",
    ].join("\n");
    // Without this an empty recording transcribes as the literal string
    // "[BLANK_AUDIO]" and the agent is asked to act on it.
    expect(parseWhisperOutput(raw)).toBe("Okay, go ahead.");
  });

  it("returns an empty string when the recording held no speech at all", () => {
    expect(parseWhisperOutput("[00:00:00.000 --> 00:00:30.000]   [BLANK_AUDIO]\n\n")).toBe("");
    expect(parseWhisperOutput("")).toBe("");
    expect(parseWhisperOutput("\n   \n\t\n")).toBe("");
  });

  it("collapses whitespace and handles CRLF from a Windows-built binary", () => {
    expect(parseWhisperOutput("[00:00:00.000 --> 00:00:01.000]    Hello    there.\r\n\r\n")).toBe("Hello there.");
  });

  it("leaves plain text alone", () => {
    expect(parseWhisperOutput("Deny code 197 on the second line item.")).toBe(
      "Deny code 197 on the second line item.",
    );
  });
});

// ── Local prerequisites ──────────────────────────────────────────────────────

describe("local prerequisite checks", () => {
  it("names speech.local.whisperBin and gives an install hint when the binary is missing", () => {
    const problem = checkWhisperPrereqs(config().local, withoutKeys, { exists: nothingExists });
    expect(problem).toBeDefined();
    expect(problem).toContain("speech.local.whisperBin");
    expect(problem).toContain("/opt/whisper/whisper-cli");
    expect(problem).toMatch(/whisper\.cpp/);
  });

  it("names speech.local.whisperModel when only the model is missing", () => {
    const cfg = config().local;
    // Binary present, model absent — the message must point at the model field,
    // not repeat the binary complaint.
    const problem = checkWhisperPrereqs(cfg, withoutKeys, {
      exists: (p) => p === cfg.whisperBin,
    });
    expect(problem).toContain("speech.local.whisperModel");
    expect(problem).not.toContain("speech.local.whisperBin");
    expect(problem).toMatch(/download-ggml-model/);
  });

  it("names speech.local.piperBin and speech.local.piperVoice for the TTS side", () => {
    const cfg = config().local;
    expect(checkPiperPrereqs(cfg, withoutKeys, { exists: nothingExists })).toContain("speech.local.piperBin");
    const voiceOnly = checkPiperPrereqs(cfg, withoutKeys, { exists: (p) => p === cfg.piperBin });
    expect(voiceOnly).toContain("speech.local.piperVoice");
  });

  it("passes when both the binary and the model are present", () => {
    expect(checkWhisperPrereqs(config().local, withoutKeys, { exists: everythingExists })).toBeUndefined();
    expect(checkPiperPrereqs(config().local, withoutKeys, { exists: everythingExists })).toBeUndefined();
  });

  it("resolves a bare binary name along PATH, the way a shell would", () => {
    const env: SpeechEnv = { PATH: "/usr/local/bin:/usr/bin" };
    expect(resolveBinary("whisper-cli", env, (p) => p === "/usr/bin/whisper-cli")).toBe("/usr/bin/whisper-cli");
    expect(resolveBinary("whisper-cli", env, nothingExists)).toBeUndefined();
    // An absolute path is taken literally rather than searched for.
    expect(resolveBinary("/opt/whisper/x", env, (p) => p === "/opt/whisper/x")).toBe("/opt/whisper/x");
    expect(resolveBinary("", env, everythingExists)).toBeUndefined();
  });

  it("returns a helpful error instead of an uncaught ENOENT when transcribing without a binary", async () => {
    const provider = new LocalSpeechProvider(config({ engine: "local" }), withoutKeys);
    const result = await provider.transcribe(Buffer.from("not really audio"), "audio/wav");
    expect(result.text).toBe("");
    expect(result.error).toContain("speech.local.whisperBin");
  });

  it("returns a helpful error instead of an uncaught ENOENT when synthesizing without Piper", async () => {
    const provider = new LocalSpeechProvider(config({ engine: "local" }), withoutKeys);
    const result = await provider.synthesize("Claim 4429 was denied.");
    expect("error" in result).toBe(true);
    expect("error" in result && result.error).toContain("speech.local.piperBin");
  });
});

// ── Cloud request builders ───────────────────────────────────────────────────

function mustBuild(built: SpeechHttpRequest | string): SpeechHttpRequest {
  if (isRequestError(built)) throw new Error(`expected a request, got: ${built}`);
  return built;
}

describe("buildOpenAiTranscribeRequest", () => {
  const audio = Buffer.from("RIFFfake-wav-bytes");

  it("builds the multipart transcription POST field by field", () => {
    const req = mustBuild(
      buildOpenAiTranscribeRequest(config().cloud, withKeys, audio, "audio/wav", { boundary: "BOUND" }),
    );
    expect(req.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_STT_KEY}`);
    expect(req.headers["Content-Type"]).toBe("multipart/form-data; boundary=BOUND");

    const body = (req.body as Buffer).toString("utf8");
    expect(body).toContain('Content-Disposition: form-data; name="model"');
    expect(body).toContain("whisper-1");
    expect(body).toContain('name="file"; filename="audio.wav"');
    expect(body).toContain("Content-Type: audio/wav");
    expect(body).toContain("RIFFfake-wav-bytes");
    expect(body.endsWith("--BOUND--\r\n")).toBe(true);
  });

  it("derives the filename extension from the mime type, since OpenAI infers the codec from it", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionForMime("audio/mpeg")).toBe("mp3");
    expect(extensionForMime("application/octet-stream")).toBe("webm");
    const req = mustBuild(
      buildOpenAiTranscribeRequest(config().cloud, withKeys, audio, "audio/webm;codecs=opus", { boundary: "B" }),
    );
    expect((req.body as Buffer).toString("utf8")).toContain('filename="audio.webm"');
  });

  it("returns an error naming speech.cloud.sttKeyEnv and the variable when the key is unset", () => {
    const built = buildOpenAiTranscribeRequest(config().cloud, withoutKeys, audio, "audio/wav");
    expect(isRequestError(built)).toBe(true);
    expect(built as string).toContain("SPEECH_STT_KEY");
    expect(built as string).toContain("speech.cloud.sttKeyEnv");
  });
});

describe("buildDeepgramTranscribeRequest", () => {
  const cfg = config({ cloud: { ...config().cloud, sttVendor: "deepgram", sttModel: "nova-2-medical" } }).cloud;
  const audio = Buffer.from("opus-bytes");

  it("posts raw audio with the codec in Content-Type and the model in the query", () => {
    const req = mustBuild(buildDeepgramTranscribeRequest(cfg, withKeys, audio, "audio/webm"));
    expect(req.url).toBe(
      "https://api.deepgram.com/v1/listen?model=nova-2-medical&smart_format=true&punctuate=true",
    );
    expect(req.method).toBe("POST");
    // Deepgram's scheme is Token, not Bearer — a Bearer 401s and blames the key.
    expect(req.headers.Authorization).toBe(`Token ${FAKE_STT_KEY}`);
    expect(req.headers["Content-Type"]).toBe("audio/webm");
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).equals(audio)).toBe(true);
  });

  it("returns an error naming speech.cloud.sttKeyEnv when the key is unset", () => {
    const built = buildDeepgramTranscribeRequest(cfg, withoutKeys, audio, "audio/webm");
    expect(isRequestError(built)).toBe(true);
    expect(built as string).toContain("speech.cloud.sttKeyEnv");
    expect(built as string).toContain("SPEECH_STT_KEY");
  });
});

describe("buildOpenAiSpeechRequest", () => {
  it("builds the JSON speech POST field by field", () => {
    const req = mustBuild(buildOpenAiSpeechRequest(config().cloud, withKeys, "Claim 4429 was denied."));
    expect(req.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TTS_KEY}`);
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body as string)).toEqual({
      model: "tts-1",
      voice: "alloy",
      input: "Claim 4429 was denied.",
      response_format: "mp3",
    });
  });

  it("returns an error naming speech.cloud.ttsKeyEnv when the key is unset", () => {
    const built = buildOpenAiSpeechRequest(config().cloud, withoutKeys, "hello");
    expect(isRequestError(built)).toBe(true);
    expect(built as string).toContain("speech.cloud.ttsKeyEnv");
    expect(built as string).toContain("SPEECH_TTS_KEY");
  });
});

describe("buildElevenLabsSpeechRequest", () => {
  const cfg = config({
    cloud: { ...config().cloud, ttsVendor: "elevenlabs", ttsModel: "eleven_turbo_v2", ttsVoice: "21m00Tcm4TlvDq8ikWAM" },
  }).cloud;

  it("puts the voice id in the path and the key in xi-api-key", () => {
    const req = mustBuild(buildElevenLabsSpeechRequest(cfg, withKeys, "Reference number 8842197."));
    expect(req.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(req.method).toBe("POST");
    expect(req.headers["xi-api-key"]).toBe(FAKE_TTS_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers.Accept).toBe("audio/mpeg");
    expect(JSON.parse(req.body as string)).toEqual({
      text: "Reference number 8842197.",
      model_id: "eleven_turbo_v2",
    });
  });

  it("names speech.cloud.ttsVoice when no voice id is configured", () => {
    const built = buildElevenLabsSpeechRequest({ ...cfg, ttsVoice: "" }, withKeys, "hi");
    expect(isRequestError(built)).toBe(true);
    expect(built as string).toContain("speech.cloud.ttsVoice");
  });

  it("returns an error naming speech.cloud.ttsKeyEnv when the key is unset", () => {
    const built = buildElevenLabsSpeechRequest(cfg, withoutKeys, "hi");
    expect(isRequestError(built)).toBe(true);
    expect(built as string).toContain("speech.cloud.ttsKeyEnv");
  });
});

// ── Response parsing ─────────────────────────────────────────────────────────

describe("parseTranscriptResponse", () => {
  it("reads OpenAI's flat {text}", () => {
    expect(parseTranscriptResponse("openai", { text: "  Prior auth is on file.  " })).toBe("Prior auth is on file.");
  });

  it("reads Deepgram's nested transcript", () => {
    const payload = {
      metadata: { request_id: "abc" },
      results: {
        channels: [
          {
            alternatives: [
              { transcript: "Denial code 197.", confidence: 0.98 },
              { transcript: "Denial code 190.", confidence: 0.4 },
            ],
          },
        ],
      },
    };
    expect(parseTranscriptResponse("deepgram", payload)).toBe("Denial code 197.");
  });

  it("returns an empty string for malformed payloads instead of throwing", () => {
    // These are all real failure shapes: an error envelope, a rate-limit body,
    // a truncated response, a schema change. None may crash a turn.
    const malformed: unknown[] = [
      null,
      undefined,
      "rate limited",
      42,
      {},
      { error: { message: "quota exceeded" } },
      { results: {} },
      { results: { channels: [] } },
      { results: { channels: [{}] } },
      { results: { channels: [{ alternatives: [] }] } },
      { results: { channels: [{ alternatives: [{ confidence: 0.9 }] }] } },
      { text: 12345 },
    ];
    for (const payload of malformed) {
      expect(() => parseTranscriptResponse("openai", payload)).not.toThrow();
      expect(parseTranscriptResponse("openai", payload)).toBe("");
      expect(() => parseTranscriptResponse("deepgram", payload)).not.toThrow();
      expect(parseTranscriptResponse("deepgram", payload)).toBe("");
    }
  });
});

// ── Descriptions, capabilities and posture ───────────────────────────────────

describe("describe() and capabilities()", () => {
  it("states the browser privacy fact plainly rather than as a footnote", () => {
    const description = new BrowserSpeechProvider(config({ engine: "browser" })).describe();
    expect(description).toMatch(/Google/);
    expect(description).toMatch(/UNSUITABLE for real PHI/);
    expect(description).toMatch(/uploads captured audio/i);
  });

  it("says the local engine keeps everything on the machine", () => {
    const description = new LocalSpeechProvider(config({ engine: "local" }), withoutKeys).describe();
    expect(description).toMatch(/no audio, transcript, or spoken reply leaves this host/i);
    expect(description).toContain("speech.local.whisperBin");
  });

  it("says the cloud engine discloses audio to a vendor and needs a BAA", () => {
    const description = new CloudSpeechProvider(config({ engine: "cloud" }), withKeys).describe();
    expect(description).toMatch(/BAA/);
    expect(description).toMatch(/sent to a third party/i);
    // Presence of a key is reported; the key is not.
    expect(description).toContain("SPEECH_STT_KEY: set");
  });

  it("reports key absence without inventing one", () => {
    const description = new CloudSpeechProvider(config({ engine: "cloud" }), withoutKeys).describe();
    expect(description).toContain("SPEECH_STT_KEY: NOT SET");
    expect(description).toContain("SPEECH_TTS_KEY: NOT SET");
  });

  it("exposes capabilities per engine", () => {
    expect(new BrowserSpeechProvider(config()).capabilities()).toMatchObject({ stt: true, tts: true, streaming: true });
    expect(new LocalSpeechProvider(config(), withoutKeys).capabilities()).toMatchObject({ streaming: false });
    expect(new CloudSpeechProvider(config(), withKeys).capabilities().note).toContain("openai");
  });

  it("makes the browser adapter refuse server-side work with an explanation", async () => {
    const provider = new BrowserSpeechProvider(config({ engine: "browser" }));
    const heard = await provider.transcribe(Buffer.from("x"), "audio/webm");
    expect(heard.text).toBe("");
    expect(heard.error).toMatch(/Web Speech API/);
    const spoken = await provider.synthesize("hello");
    expect("error" in spoken).toBe(true);
    expect("error" in spoken && spoken.error).toMatch(/speechSynthesis/);
  });
});

// ── Status report ────────────────────────────────────────────────────────────

describe("speechStatus", () => {
  it("reports engine, mode, consent and PHI posture for the local engine", () => {
    const status = speechStatus(config({ engine: "local" }), withoutKeys);
    expect(status).toContain('engine "local"');
    expect(status).toContain('mode "push-to-talk"');
    expect(status).toContain("discarded after transcription");
    expect(status).toContain("PHI posture: SAFE");
    // Nothing is installed in this test environment, so both must read MISSING
    // and name their fields.
    expect(status).toContain("speech.local.whisperBin");
    expect(status).toContain("speech.local.piperBin");
  });

  it("reports missing cloud keys by variable name and by config field", () => {
    const status = speechStatus(config({ engine: "cloud" }), withoutKeys);
    expect(status).toContain("SPEECH_STT_KEY NOT SET");
    expect(status).toContain("speech.cloud.sttKeyEnv");
    expect(status).toContain("PHI posture: REQUIRES BAA");
  });

  it("reports the browser engine's posture as unsuitable", () => {
    const status = speechStatus(config({ engine: "browser", enabled: false }), withoutKeys);
    expect(status).toContain("Speech: disabled");
    expect(status).toContain("PHI posture: UNSUITABLE");
  });

  it("describes a bad engine instead of throwing — a status report must still print", () => {
    const status = speechStatus(config({ engine: "nonsense" as SpeechConfig["engine"] }), withoutKeys);
    expect(status).toContain('unknown speech engine "nonsense"');
  });
});

// ── The secret must never surface ────────────────────────────────────────────

describe("no key ever appears in describable output", () => {
  // The precedent is describeTwilioRequest in src/voice/provider.ts: a request
  // may carry a credential, but nothing that formats one for a human may.
  const cases: Array<{ name: string; cfg: SpeechConfig }> = [
    { name: "openai/openai", cfg: config({ engine: "cloud" }) },
    {
      name: "deepgram/elevenlabs",
      cfg: config({
        engine: "cloud",
        cloud: {
          ...config().cloud,
          sttVendor: "deepgram",
          ttsVendor: "elevenlabs",
          sttModel: "nova-2-medical",
          ttsModel: "eleven_turbo_v2",
          ttsVoice: "21m00Tcm4TlvDq8ikWAM",
        },
      }),
    },
  ];

  for (const { name, cfg } of cases) {
    it(`keeps the key out of describe(), status and redacted requests (${name})`, () => {
      const provider = new CloudSpeechProvider(cfg, withKeys);
      const audio = Buffer.from("audio-bytes");

      const humanText = [
        provider.describe(),
        speechStatus(cfg, withKeys),
        JSON.stringify(provider.capabilities()),
        describeSpeechRequest(
          mustBuild(
            cfg.cloud.sttVendor === "deepgram"
              ? buildDeepgramTranscribeRequest(cfg.cloud, withKeys, audio, "audio/webm")
              : buildOpenAiTranscribeRequest(cfg.cloud, withKeys, audio, "audio/wav"),
          ),
        ),
        describeSpeechRequest(
          mustBuild(
            cfg.cloud.ttsVendor === "elevenlabs"
              ? buildElevenLabsSpeechRequest(cfg.cloud, withKeys, "hello")
              : buildOpenAiSpeechRequest(cfg.cloud, withKeys, "hello"),
          ),
        ),
      ].join("\n");

      expect(humanText).not.toContain(FAKE_STT_KEY);
      expect(humanText).not.toContain(FAKE_TTS_KEY);
      expect(humanText).not.toContain("STTSECRETVALUE");
      expect(humanText).not.toContain("TTSSECRETVALUE");
      // The env var NAMES are what a status report is for, so they must survive.
      expect(humanText).toContain("SPEECH_STT_KEY");
      expect(humanText).toContain("SPEECH_TTS_KEY");
      expect(humanText).toContain("[not shown]");
    });
  }

  it("keeps the key out of every builder's error text", () => {
    // Errors are the sneakiest leak: they get logged, wrapped and pasted into
    // tickets. Build with a key present but a different failure, and with no key.
    const cfg = config({ engine: "cloud" }).cloud;
    const errors = [
      buildOpenAiTranscribeRequest(cfg, withoutKeys, Buffer.from("x"), "audio/wav"),
      buildDeepgramTranscribeRequest({ ...cfg, sttVendor: "deepgram" }, withoutKeys, Buffer.from("x"), "audio/webm"),
      buildOpenAiSpeechRequest(cfg, withoutKeys, "hi"),
      buildElevenLabsSpeechRequest({ ...cfg, ttsVendor: "elevenlabs", ttsVoice: "" }, withKeys, "hi"),
    ].filter(isRequestError);

    expect(errors).toHaveLength(4);
    for (const error of errors) {
      expect(error).not.toContain(FAKE_STT_KEY);
      expect(error).not.toContain(FAKE_TTS_KEY);
    }
  });

  it("keeps the key out of anything the factory throws", () => {
    const bad = config({ engine: "cloud-but-typoed" as SpeechConfig["engine"] });
    try {
      createSpeechProvider(bad, withKeys);
      expect.unreachable("factory should have thrown");
    } catch (err) {
      const thrown = `${(err as Error).message}\n${(err as Error).stack ?? ""}`;
      expect(thrown).not.toContain(FAKE_STT_KEY);
      expect(thrown).not.toContain(FAKE_TTS_KEY);
      expect(thrown).toContain('unknown speech engine "cloud-but-typoed"');
    }
  });

  it("redacts every credential header shape, not just Authorization", () => {
    const redacted = describeSpeechRequest({
      url: "https://example.test/v1/speak",
      method: "POST",
      headers: { Authorization: `Bearer ${FAKE_STT_KEY}`, "xi-api-key": FAKE_TTS_KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(redacted).not.toContain(FAKE_STT_KEY);
    expect(redacted).not.toContain(FAKE_TTS_KEY);
    expect(redacted).toContain("Authorization: [not shown]");
    expect(redacted).toContain("xi-api-key: [not shown]");
    expect(redacted).toContain("Content-Type: application/json");
  });
});
