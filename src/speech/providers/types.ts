// Speech in, speech out — behind one interface, because the three ways to do it
// differ in the only dimension this deployment actually cares about: where the
// audio ends up. A voice recording of a coder reading a member ID out loud is
// PHI, and "the browser did it" or "the vendor is cheap" is not a disclosure
// defence. So every adapter has to answer the same question in `describe()`,
// and the answer is part of the interface rather than a comment.

/**
 * The `speech` config section, restated structurally.
 *
 * Declared here rather than imported from config/config.ts on purpose: this
 * module is the one that has to keep working while the config schema is being
 * edited by someone else, and a structural type means the two can be developed
 * against each other without a circular import or a merge conflict in a file
 * neither owner should be touching.
 */
export type SpeechEngine = "browser" | "local" | "cloud";
export type SpeechMode = "push-to-talk" | "always-on";
export type SttVendor = "openai" | "deepgram";
export type TtsVendor = "openai" | "elevenlabs";

export interface SpeechLocalConfig {
  whisperBin: string;
  whisperModel: string;
  piperBin: string;
  piperVoice: string;
}

export interface SpeechCloudConfig {
  sttVendor: SttVendor;
  ttsVendor: TtsVendor;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  /** Name of the env var holding the STT key — never the key itself. */
  sttKeyEnv: string;
  /** Name of the env var holding the TTS key — never the key itself. */
  ttsKeyEnv: string;
}

export interface SpeechConsentConfig {
  requireAcknowledgement: boolean;
  retainAudio: boolean;
}

export interface SpeechConfig {
  enabled: boolean;
  engine: SpeechEngine;
  mode: SpeechMode;
  wakeWord: string;
  speakReplies: boolean;
  maxSpokenChars: number;
  local: SpeechLocalConfig;
  cloud: SpeechCloudConfig;
  consent: SpeechConsentConfig;
}

/**
 * Environment lookup, passed in rather than read from `process.env` at module
 * scope. Keys are read at call time (a key rotated mid-process should take
 * effect), and a test can hand over a fake environment without mutating the
 * real one.
 */
export type SpeechEnv = Record<string, string | undefined>;

export interface SpeechCapabilities {
  stt: boolean;
  tts: boolean;
  /** Whether partial transcripts arrive while the speaker is still talking. */
  streaming: boolean;
  /** One line of nuance the three booleans cannot carry. */
  note: string;
}

export type TranscriptResult = { text: string; error?: string };
export type SynthesisResult = { audio: Buffer; mimeType: string } | { error: string };

/** Narrowing helper — `"error" in result` reads badly at every call site. */
export function isSynthesisError(result: SynthesisResult): result is { error: string } {
  return "error" in result;
}

export interface SpeechProvider {
  readonly name: string;
  /**
   * True when the actual work happens in the user's browser and the server side
   * is only a descriptor. Callers use this to decide whether to route audio to
   * the server at all — not to decide whether the feature exists.
   */
  readonly runsInBrowser: boolean;
  transcribe(audio: Buffer, mimeType: string): Promise<TranscriptResult>;
  synthesize(text: string): Promise<SynthesisResult>;
  capabilities(): SpeechCapabilities;
  /**
   * A human line for a status report.
   *
   * MUST NEVER include an API key, a token, or an Authorization header — this
   * string is printed to terminals, written to status pages, and pasted into
   * bug reports. Name the env var, never its value.
   */
  describe(): string;
}
