import type {
  SpeechCapabilities,
  SpeechConfig,
  SpeechProvider,
  SynthesisResult,
  TranscriptResult,
} from "./types.js";
import { describeVocabulary, renderVocabularyPrompt, sanitizeHints } from "../vocabulary.js";

/**
 * The browser engine — a descriptor, not an implementation.
 *
 * Web Speech API recognition and synthesis run entirely inside the page: the
 * microphone stream never reaches this process, and there is no server-side
 * work to do. The adapter exists anyway so the factory has something to return
 * and the status report has something to describe; its transcribe/synthesize
 * exist only to fail loudly when a caller routes audio here by mistake, which
 * is a routing bug worth naming rather than a silent no-op.
 */
export class BrowserSpeechProvider implements SpeechProvider {
  readonly name = "browser";
  readonly runsInBrowser = true;

  /** Sanitized once at construction so `grammar()` cannot be the leaky path. */
  private readonly hints: string[];

  constructor(
    private cfg: SpeechConfig,
    hints: string[] = [],
  ) {
    this.hints = sanitizeHints(hints);
  }

  /**
   * The vocabulary as a JSGF grammar, for the page to hand to SpeechGrammarList.
   *
   * This adapter cannot apply hints itself — recognition happens in the browser,
   * so the grammar has to travel there. Publishing it as a method rather than
   * smuggling it into transcribe() keeps the honest shape: the server owns the
   * vocabulary (it is the side that can see the database), the page owns the
   * recognizer, and this is the seam between them. Empty when there is no
   * vocabulary, because an empty JSGF rule is a parse error rather than a no-op.
   */
  grammar(): string {
    return renderVocabularyPrompt(this.hints, "grammar");
  }

  /** The hint list as handed over, already filtered — for the page and for status. */
  vocabulary(): string[] {
    return [...this.hints];
  }

  async transcribe(_audio: Buffer, _mimeType: string, _hints?: string[]): Promise<TranscriptResult> {
    return {
      text: "",
      error:
        "The browser engine transcribes in the page (Web Speech API), so the server never receives audio. " +
        'Reaching this code means audio was posted to the server anyway — send the recognized text instead, or set speech.engine to "local" or "cloud" for server-side transcription.',
    };
  }

  async synthesize(_text: string): Promise<SynthesisResult> {
    return {
      error:
        "The browser engine speaks in the page (speechSynthesis), so the server produces no audio. " +
        'Reaching this code means synthesis was requested from the server — send the text to the client and let it speak, or set speech.engine to "local" or "cloud".',
    };
  }

  capabilities(): SpeechCapabilities {
    return {
      stt: true,
      tts: true,
      // Chrome fires interim results as you speak; that is the one thing this
      // engine does better than the others.
      streaming: true,
      // False because nothing this process builds carries them — the grammar is
      // published via grammar() for the page to install. Saying "true" here
      // would tell a caller the server applied a vocabulary it never sent.
      acceptsHints: false,
      note:
        "Runs in the page. Chrome/Edge only for recognition; Safari and Firefox have partial or no support." +
        (this.hints.length > 0
          ? ` A JSGF grammar of ${this.hints.length} terms is published via grammar() for the page to install.`
          : ""),
    };
  }

  describe(): string {
    // The privacy fact goes in plainly rather than as a footnote. Chrome's
    // SpeechRecognition is not on-device: it streams the microphone to Google's
    // servers and returns text. That is a disclosure to a third party with no
    // BAA, which makes this engine a demo convenience and nothing more.
    return [
      "browser (Web Speech API) — recognition and synthesis run in the user's browser.",
      "  PRIVACY: Chrome's SpeechRecognition uploads captured audio to Google's servers for recognition.",
      "  It is a third-party disclosure with no BAA, so this engine is UNSUITABLE for real PHI —",
      '  dictating a member ID, name, or DOB under this engine is a reportable disclosure. Use engine "local" for PHI.',
      `  mode=${this.cfg.mode}  wakeWord="${this.cfg.wakeWord}"  speakReplies=${this.cfg.speakReplies}`,
      // Named in the status line because "why did it still hear 'availability'?"
      // is answered by whether a grammar was ever handed to the page at all.
      `  ${describeVocabulary(this.hints)} (JSGF, installed by the page — see grammar())`,
    ].join("\n");
  }
}
