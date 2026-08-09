import type {
  SpeechCapabilities,
  SpeechCloudConfig,
  SpeechConfig,
  SpeechEnv,
  SpeechProvider,
  SttVendor,
  SynthesisResult,
  TranscriptResult,
  TtsVendor,
} from "./types.js";

// ── Requests as data ─────────────────────────────────────────────────────────
// Every vendor call is built as a value first and sent second. That split is
// what lets the interesting parts — the URL, the model, the multipart field
// names, and above all which header carries the key — be asserted in a test
// with no network, no account, and no live key.

export interface SpeechHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string | Buffer;
}

/** Builders return the request, or a sentence explaining why there isn't one. */
export type BuiltRequest = SpeechHttpRequest | string;

export function isRequestError(built: BuiltRequest): built is string {
  return typeof built === "string";
}

// Headers whose VALUE is a credential. Listed once so that every redaction
// path — describe, status, error text — agrees on what a secret looks like.
const SECRET_HEADERS = ["authorization", "xi-api-key", "api-key", "x-api-key"];

/**
 * Render a request for a log or a status page with the credential removed.
 *
 * Modelled on describeTwilioRequest in src/voice/provider.ts, and for the same
 * reason: the moment a request object is printed anywhere — a debug line, an
 * error, a bug report pasted into a ticket — the Authorization header goes with
 * it. Redacting at the one place that formats requests is the only version of
 * this that stays true as call sites are added.
 */
export function describeSpeechRequest(request: SpeechHttpRequest): string {
  const headers = Object.entries(request.headers).map(([k, v]) =>
    SECRET_HEADERS.includes(k.toLowerCase()) ? `  ${k}: [not shown]` : `  ${k}: ${v}`,
  );
  const size = typeof request.body === "string" ? `${request.body.length} chars` : `${request.body.length} bytes`;
  return [`${request.method} ${request.url}`, ...headers, `  body: ${size}`].join("\n");
}

function missingKeyMessage(envVar: string, field: string, vendor: string): string {
  return `No API key for ${vendor}: the environment variable ${envVar} is not set (config field speech.cloud.${field} names it). Export ${envVar} in the environment this process runs under, or set speech.engine to "local" to keep speech on this machine.`;
}

/** OpenAI infers the codec from the filename, so the part needs a real extension. */
export function extensionForMime(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/flac": "flac",
  };
  return map[mimeType.split(";")[0]!.trim().toLowerCase()] ?? "webm";
}

export interface BuildOptions {
  /**
   * Multipart boundary. Defaulted but overridable so a test can assert the body
   * byte-for-byte; a random boundary would make the request unassertable and
   * the assertion is the point of building it separately.
   */
  boundary?: string;
}

const DEFAULT_BOUNDARY = "----aetheraclaw-speech-boundary";

/** POST /v1/audio/transcriptions — multipart, file part plus a model field. */
export function buildOpenAiTranscribeRequest(
  cfg: SpeechCloudConfig,
  env: SpeechEnv,
  audio: Buffer,
  mimeType: string,
  opts: BuildOptions = {},
): BuiltRequest {
  const key = env[cfg.sttKeyEnv];
  if (!key) return missingKeyMessage(cfg.sttKeyEnv, "sttKeyEnv", "OpenAI transcription");

  const boundary = opts.boundary ?? DEFAULT_BOUNDARY;
  const filename = `audio.${extensionForMime(mimeType)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n${cfg.sttModel}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    url: "https://api.openai.com/v1/audio/transcriptions",
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat([head, audio, tail]),
  };
}

/** POST /v1/listen — Deepgram takes raw audio with the codec in Content-Type. */
export function buildDeepgramTranscribeRequest(
  cfg: SpeechCloudConfig,
  env: SpeechEnv,
  audio: Buffer,
  mimeType: string,
): BuiltRequest {
  const key = env[cfg.sttKeyEnv];
  if (!key) return missingKeyMessage(cfg.sttKeyEnv, "sttKeyEnv", "Deepgram");

  // smart_format gives punctuation and casing; without it the transcript
  // arrives as one lowercase run, which reads badly and parses worse.
  const query = new URLSearchParams({ model: cfg.sttModel, smart_format: "true", punctuate: "true" });
  return {
    url: `https://api.deepgram.com/v1/listen?${query.toString()}`,
    method: "POST",
    headers: {
      // Deepgram's scheme is "Token", not "Bearer" — a Bearer here 401s with a
      // message that blames the key rather than the scheme.
      Authorization: `Token ${key}`,
      "Content-Type": mimeType,
    },
    body: audio,
  };
}

/** POST /v1/audio/speech — OpenAI TTS. */
export function buildOpenAiSpeechRequest(
  cfg: SpeechCloudConfig,
  env: SpeechEnv,
  text: string,
): BuiltRequest {
  const key = env[cfg.ttsKeyEnv];
  if (!key) return missingKeyMessage(cfg.ttsKeyEnv, "ttsKeyEnv", "OpenAI speech");

  return {
    url: "https://api.openai.com/v1/audio/speech",
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.ttsModel,
      voice: cfg.ttsVoice,
      input: text,
      response_format: "mp3",
    }),
  };
}

/** POST /v1/text-to-speech/{voice} — ElevenLabs puts the voice in the path. */
export function buildElevenLabsSpeechRequest(
  cfg: SpeechCloudConfig,
  env: SpeechEnv,
  text: string,
): BuiltRequest {
  const key = env[cfg.ttsKeyEnv];
  if (!key) return missingKeyMessage(cfg.ttsKeyEnv, "ttsKeyEnv", "ElevenLabs");
  if (!cfg.ttsVoice) {
    return 'No ElevenLabs voice id is configured (config field speech.cloud.ttsVoice). ElevenLabs addresses voices by id in the URL path, so a name will not do.';
  }

  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.ttsVoice)}`,
    method: "POST",
    headers: {
      // ElevenLabs uses its own header rather than Authorization; it is still a
      // credential, and SECRET_HEADERS lists it so redaction covers it too.
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, model_id: cfg.ttsModel }),
  };
}

/**
 * Pull the transcript out of a vendor response.
 *
 * Written defensively on purpose: these payloads arrive from the network, and a
 * rate-limit body, an error envelope, or a schema change all look like "not the
 * shape we expected". Throwing on any of them would turn a bad minute at the
 * vendor into a crashed turn, so an unrecognised payload yields "" and lets the
 * caller report a transcription failure.
 */
export function parseTranscriptResponse(vendor: SttVendor, json: unknown): string {
  if (json === null || typeof json !== "object") return "";
  const root = json as Record<string, unknown>;

  if (vendor === "openai") {
    return typeof root.text === "string" ? root.text.trim() : "";
  }

  // Deepgram: results.channels[0].alternatives[0].transcript
  const results = root.results as Record<string, unknown> | undefined;
  if (!results || typeof results !== "object") return "";
  const channels = results.channels;
  if (!Array.isArray(channels) || channels.length === 0) return "";
  const first = channels[0] as Record<string, unknown> | undefined;
  const alternatives = first?.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return "";
  const best = alternatives[0] as Record<string, unknown> | undefined;
  return typeof best?.transcript === "string" ? best.transcript.trim() : "";
}

// ── The side-effecting part ──────────────────────────────────────────────────

/**
 * Vendor speech services.
 *
 * The trade this engine makes: better recognition, at the cost of sending audio
 * off the machine. Audio of a coder reading a chart is PHI, so this engine is
 * only defensible under a signed BAA with the vendor — which `describe()` says
 * out loud rather than leaving to a runbook.
 */
export class CloudSpeechProvider implements SpeechProvider {
  readonly name = "cloud";
  readonly runsInBrowser = false;

  constructor(
    private cfg: SpeechConfig,
    private env: SpeechEnv = process.env,
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscriptResult> {
    const cloud = this.cfg.cloud;
    const built =
      cloud.sttVendor === "deepgram"
        ? buildDeepgramTranscribeRequest(cloud, this.env, audio, mimeType)
        : buildOpenAiTranscribeRequest(cloud, this.env, audio, mimeType);
    if (isRequestError(built)) return { text: "", error: built };

    try {
      const res = await send(built);
      if (!res.ok) {
        // The vendor's error body can echo request headers back; only the status
        // line goes into our message, never the request we built.
        return { text: "", error: `${cloud.sttVendor} transcription failed: HTTP ${res.status} ${res.statusText}` };
      }
      const json = (await res.json()) as unknown;
      const text = parseTranscriptResponse(cloud.sttVendor, json);
      if (!text) return { text: "", error: `${cloud.sttVendor} returned no transcript for this audio.` };
      return { text };
    } catch (err) {
      return { text: "", error: `${cloud.sttVendor} transcription failed: ${(err as Error).message}` };
    }
  }

  async synthesize(text: string): Promise<SynthesisResult> {
    const cloud = this.cfg.cloud;
    const spoken = text.slice(0, this.cfg.maxSpokenChars);
    const built =
      cloud.ttsVendor === "elevenlabs"
        ? buildElevenLabsSpeechRequest(cloud, this.env, spoken)
        : buildOpenAiSpeechRequest(cloud, this.env, spoken);
    if (isRequestError(built)) return { error: built };

    try {
      const res = await send(built);
      if (!res.ok) return { error: `${cloud.ttsVendor} speech failed: HTTP ${res.status} ${res.statusText}` };
      const audio = Buffer.from(await res.arrayBuffer());
      return { audio, mimeType: res.headers.get("content-type") ?? "audio/mpeg" };
    } catch (err) {
      return { error: `${cloud.ttsVendor} speech failed: ${(err as Error).message}` };
    }
  }

  capabilities(): SpeechCapabilities {
    return {
      stt: true,
      tts: true,
      // Both vendors offer websocket streaming; this adapter posts whole
      // utterances, which is what the push-to-talk flow needs.
      streaming: false,
      note: `Whole-utterance HTTP calls to ${this.cfg.cloud.sttVendor} (STT) and ${this.cfg.cloud.ttsVendor} (TTS).`,
    };
  }

  describe(): string {
    const cloud = this.cfg.cloud;
    // Env var NAMES only. Whether a key is present is useful; the key itself is
    // never printed here or anywhere else in this module.
    const sttKey = this.env[cloud.sttKeyEnv] ? "set" : "NOT SET";
    const ttsKey = this.env[cloud.ttsKeyEnv] ? "set" : "NOT SET";
    return [
      `cloud — STT via ${cloud.sttVendor} (${cloud.sttModel}), TTS via ${cloud.ttsVendor} (${cloud.ttsModel}, voice ${cloud.ttsVoice}).`,
      "  PRIVACY: recorded audio and spoken replies are sent to a third party. Dictated PHI is a disclosure,",
      "  so this engine requires a signed BAA with each vendor before it is used with real patient data.",
      `  key ${cloud.sttKeyEnv}: ${sttKey} (speech.cloud.sttKeyEnv)`,
      `  key ${cloud.ttsKeyEnv}: ${ttsKey} (speech.cloud.ttsKeyEnv)`,
      `  mode=${this.cfg.mode}  wakeWord="${this.cfg.wakeWord}"  speakReplies=${this.cfg.speakReplies}`,
    ].join("\n");
  }
}

/** The one place a built request meets the network. */
async function send(request: SpeechHttpRequest): Promise<Response> {
  const body =
    typeof request.body === "string"
      ? request.body
      : new Uint8Array(request.body.buffer, request.body.byteOffset, request.body.byteLength);
  return await fetch(request.url, { method: request.method, headers: request.headers, body });
}

/** Which vendors this adapter knows how to talk to, for status and validation. */
export const STT_VENDORS: readonly SttVendor[] = ["openai", "deepgram"];
export const TTS_VENDORS: readonly TtsVendor[] = ["openai", "elevenlabs"];
