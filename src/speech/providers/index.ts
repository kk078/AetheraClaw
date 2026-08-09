import { BrowserSpeechProvider } from "./browser.js";
import { CloudSpeechProvider } from "./cloud.js";
import { LocalSpeechProvider, checkPiperPrereqs, checkWhisperPrereqs, resolveBinary } from "./local.js";
import type { SpeechConfig, SpeechEnv, SpeechEngine, SpeechProvider } from "./types.js";

export const KNOWN_SPEECH_ENGINES = ["browser", "local", "cloud"] as const;

/**
 * @param hints Ranked recognition vocabulary — see src/speech/vocabulary.ts.
 *   Only the browser adapter needs it at construction time (it publishes a JSGF
 *   grammar for the page); the server-side adapters take hints per call, so a
 *   caller with a vocabulary that changes between utterances passes it to
 *   `transcribe` instead. Optional so no existing caller breaks.
 */
export function createSpeechProvider(
  cfg: SpeechConfig,
  env: SpeechEnv = process.env,
  hints: string[] = [],
): SpeechProvider {
  const engine: SpeechEngine = cfg.engine;
  switch (engine) {
    case "browser":
      return new BrowserSpeechProvider(cfg, hints);
    case "local":
      return new LocalSpeechProvider(cfg, env);
    case "cloud":
      return new CloudSpeechProvider(cfg, env);
    default:
      // The engine can arrive from a hand-edited config file or a websocket
      // message, neither of which the type system reaches. Without this default
      // the switch returned undefined and the first `provider.transcribe` deref
      // threw "Cannot read properties of undefined", naming nothing — the same
      // trap createProvider in src/providers/index.ts exists to close. Name the
      // bad value and the valid set.
      throw new Error(
        `unknown speech engine "${String(engine)}". Valid engines are: ${KNOWN_SPEECH_ENGINES.join(", ")}.`,
      );
  }
}

/**
 * A status report for `--status` output and the setup flow.
 *
 * Answers the three questions someone actually has when speech does not work —
 * which engine is selected, is the thing it needs present, and is it allowed to
 * hear PHI — without ever printing a key. Presence of a credential is reported;
 * its value never is.
 */
export function speechStatus(cfg: SpeechConfig, env: SpeechEnv = process.env): string {
  const lines: string[] = [];
  lines.push(`Speech: ${cfg.enabled ? "enabled" : "disabled"} — engine "${cfg.engine}", mode "${cfg.mode}"`);
  lines.push(`  wake word: "${cfg.wakeWord}"`);
  lines.push(`  speak replies: ${cfg.speakReplies ? `yes (max ${cfg.maxSpokenChars} chars)` : "no"}`);
  lines.push(
    `  consent: acknowledgement ${cfg.consent.requireAcknowledgement ? "required" : "not required"}, audio ${
      cfg.consent.retainAudio ? "RETAINED" : "discarded after transcription"
    }`,
  );

  switch (cfg.engine) {
    case "browser":
      lines.push("  requirements: none on the server — recognition and synthesis run in the browser.");
      lines.push("  PHI posture: UNSUITABLE. Chrome uploads captured audio to Google for recognition (no BAA).");
      break;

    case "local": {
      const whisper = checkWhisperPrereqs(cfg.local, env);
      const piper = checkPiperPrereqs(cfg.local, env);
      lines.push(
        `  whisper.cpp: ${whisper ? `MISSING — ${whisper}` : `ok (${resolveBinary(cfg.local.whisperBin, env) ?? cfg.local.whisperBin})`}`,
      );
      lines.push(
        `  piper: ${piper ? `MISSING — ${piper}` : `ok (${resolveBinary(cfg.local.piperBin, env) ?? cfg.local.piperBin})`}`,
      );
      lines.push("  PHI posture: SAFE. Audio and transcripts never leave this machine; no vendor disclosure.");
      break;
    }

    case "cloud": {
      const sttSet = Boolean(env[cfg.cloud.sttKeyEnv]);
      const ttsSet = Boolean(env[cfg.cloud.ttsKeyEnv]);
      lines.push(`  stt: ${cfg.cloud.sttVendor} (${cfg.cloud.sttModel}) — ${cfg.cloud.sttKeyEnv} ${sttSet ? "set" : "NOT SET"}`);
      lines.push(
        `  tts: ${cfg.cloud.ttsVendor} (${cfg.cloud.ttsModel}, voice ${cfg.cloud.ttsVoice}) — ${cfg.cloud.ttsKeyEnv} ${ttsSet ? "set" : "NOT SET"}`,
      );
      if (!sttSet) lines.push(`       set ${cfg.cloud.sttKeyEnv} in the environment (config field speech.cloud.sttKeyEnv).`);
      if (!ttsSet) lines.push(`       set ${cfg.cloud.ttsKeyEnv} in the environment (config field speech.cloud.ttsKeyEnv).`);
      lines.push(
        `  PHI posture: REQUIRES BAA. Audio is disclosed to ${cfg.cloud.sttVendor} and spoken text to ${cfg.cloud.ttsVendor}.`,
      );
      break;
    }

    default:
      // Reachable the same way createSpeechProvider's default is; a status
      // report that crashed on a bad config would hide the very line telling
      // the user their config is bad.
      lines.push(
        `  unknown speech engine "${String(cfg.engine)}". Valid engines are: ${KNOWN_SPEECH_ENGINES.join(", ")}.`,
      );
      break;
  }

  return lines.join("\n");
}

export { BrowserSpeechProvider } from "./browser.js";
export { CloudSpeechProvider } from "./cloud.js";
export { LocalSpeechProvider } from "./local.js";
// Re-exported here so a caller wiring speech up has one import to reach for
// rather than having to know the vocabulary lives a directory above.
export {
  buildHintVocabulary,
  describeVocabulary,
  renderVocabularyPrompt,
  sanitizeHints,
  DEFAULT_HINT_LIMIT,
  PROMPT_TOKEN_BUDGET,
} from "../vocabulary.js";
export type { VocabularySource, VocabularyOptions, VocabularyStyle } from "../vocabulary.js";
export type {
  SpeechCapabilities,
  SpeechConfig,
  SpeechEngine,
  SpeechEnv,
  SpeechProvider,
  SynthesisResult,
  TranscriptResult,
} from "./types.js";
