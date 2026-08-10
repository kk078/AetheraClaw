import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  SpeechCapabilities,
  SpeechConfig,
  SpeechEnv,
  SpeechLocalConfig,
  SpeechProvider,
  SynthesisResult,
  TranscriptResult,
} from "./types.js";
import { renderVocabularyPrompt } from "../vocabulary.js";

// ── Pure builders ────────────────────────────────────────────────────────────
// The argv is the interesting part and the part that breaks: a flag renamed
// upstream, an output file written somewhere the cleanup does not look, a model
// path silently ignored. Built here as data so a test can assert every flag
// without a whisper binary, a model file, or a microphone on the machine.

/** Strip the extension so whisper's `-of` prefix and our cleanup agree on a name. */
export function outputPrefix(audioPath: string): string {
  return audioPath.replace(/\.[^./\\]+$/, "");
}

/**
 * whisper.cpp argv.
 *
 * `-f <path>` rather than piping audio on stdin, and no transcript text on the
 * command line anywhere: argv is world-readable via `ps`, and a transcript of a
 * payer call is PHI. `-of` is passed explicitly so the sidecar `.txt` lands at a
 * path we chose — whisper's default derives it from the input and the cleanup
 * in the `finally` has to be able to name it.
 *
 * `hints`, when supplied, becomes whisper's `--prompt` — an initial prompt the
 * decoder is conditioned on. Note where that lands: on ARGV, which every process
 * on the host can read via `ps`. That is the same leak the rest of this builder
 * exists to avoid, and it is why the prompt is rendered through
 * renderVocabularyPrompt rather than joined here — that function drops
 * identifier-shaped entries, so a member ID that wandered into a payer table
 * cannot end up in the process table. Absent or empty hints must produce the
 * argv this builder produced before hints existed, unchanged.
 */
export function buildWhisperArgs(cfg: SpeechLocalConfig, audioPath: string, hints?: string[]): string[] {
  const args = [
    "-m",
    cfg.whisperModel,
    "-f",
    audioPath,
    "--output-txt",
    "--no-timestamps",
    "--output-file",
    outputPrefix(audioPath),
    // Printing progress to stdout would interleave with nothing useful; the
    // transcript is read from the file, so keep the pipe quiet.
    "--print-progress",
    "false",
  ];

  // whisper.cpp truncates its initial prompt at n_text_ctx/2 — the same 224
  // tokens OpenAI caps at — so the render is capped here rather than the binary
  // silently dropping whichever half it liked less.
  const prompt = hints?.length ? renderVocabularyPrompt(hints, "prompt") : "";
  if (prompt) args.push("--prompt", prompt);

  return args;
}

/**
 * Piper argv.
 *
 * The text to speak is NOT here — Piper reads it from stdin. Two reasons, and
 * the second is the one that matters: argv has a length limit that a long
 * assistant reply will exceed, and argv is visible to every process on the box
 * via `ps`, so a spoken reply containing a patient name would leak out of the
 * process the moment it was synthesized.
 */
export function buildPiperArgs(cfg: SpeechLocalConfig, outPath: string): string[] {
  return ["--model", cfg.piperVoice, "--output_file", outPath];
}

// A whisper timestamp line: "[00:00:00.000 --> 00:00:02.480]   Hello there."
const TIMESTAMP = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g;
// whisper's non-speech markers. It emits these as ordinary transcript lines, so
// without this an empty recording transcribes as the literal text "[BLANK_AUDIO]"
// and the agent is asked to act on it.
const NON_SPEECH = /\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE|SOUND|LAUGHTER|APPLAUSE|_[A-Z]+_)\]|\((?:silence|music|inaudible|blank[_ ]audio|no speech|noise)\)/gi;

/** Turn whisper's stdout or `.txt` sidecar into the words that were actually said. */
export function parseWhisperOutput(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(TIMESTAMP, " ").replace(NON_SPEECH, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length > 0) lines.push(cleaned);
  }
  return lines.join(" ").trim();
}

// ── Prerequisite checks ──────────────────────────────────────────────────────

/**
 * Resolve a binary the way a shell would.
 *
 * A configured value may be a path ("/opt/whisper/main") or a bare name on PATH
 * ("whisper-cli"); both are reasonable to write in a config file, so both have
 * to be checked before spawning. Without this, a typo surfaces as an
 * uncatchable async ENOENT from `spawn` with no mention of which config field
 * produced it.
 */
export function resolveBinary(
  bin: string,
  env: SpeechEnv,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (!bin) return undefined;
  if (bin.includes("/") || bin.includes(sep)) return exists(bin) ? bin : undefined;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export interface PrereqOptions {
  exists?: (p: string) => boolean;
}

/**
 * Check what the local engine needs before anything is spawned, and name the
 * exact config field when something is missing. "spawn ENOENT" tells a user
 * nothing; "speech.local.whisperBin" tells them where to look.
 */
export function checkWhisperPrereqs(
  cfg: SpeechLocalConfig,
  env: SpeechEnv,
  opts: PrereqOptions = {},
): string | undefined {
  const exists = opts.exists ?? existsSync;
  if (!resolveBinary(cfg.whisperBin, env, exists)) {
    return `whisper.cpp was not found at "${cfg.whisperBin}" (config field speech.local.whisperBin). Build it with \`git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make\` and point speech.local.whisperBin at the resulting binary, or set speech.engine to "cloud".`;
  }
  if (!cfg.whisperModel || !exists(cfg.whisperModel)) {
    return `The whisper model file was not found at "${cfg.whisperModel}" (config field speech.local.whisperModel). Download one with \`bash ./models/download-ggml-model.sh base.en\` inside the whisper.cpp checkout and point speech.local.whisperModel at the .bin file.`;
  }
  return undefined;
}

export function checkPiperPrereqs(
  cfg: SpeechLocalConfig,
  env: SpeechEnv,
  opts: PrereqOptions = {},
): string | undefined {
  const exists = opts.exists ?? existsSync;
  if (!resolveBinary(cfg.piperBin, env, exists)) {
    return `Piper was not found at "${cfg.piperBin}" (config field speech.local.piperBin). Install it from https://github.com/rhasspy/piper/releases and point speech.local.piperBin at the binary, or set speech.speakReplies to false.`;
  }
  if (!cfg.piperVoice || !exists(cfg.piperVoice)) {
    return `The Piper voice model was not found at "${cfg.piperVoice}" (config field speech.local.piperVoice). Download a voice (.onnx plus its .onnx.json) from https://huggingface.co/rhasspy/piper-voices and point speech.local.piperVoice at the .onnx file.`;
  }
  return undefined;
}

// ── The side-effecting part ──────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** spawn with the failure modes turned into values instead of unhandled events. */
function run(bin: string, args: string[], stdin?: string | Buffer): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    // `spawn` reports ENOENT as an 'error' EVENT, not a throw. An unhandled one
    // takes the whole process down, which is why this is a resolve and not a
    // rejection: a missing binary is a configuration problem to report, not a
    // crash.
    child.on("error", (err: Error) => resolve({ code: null, stdout, stderr, error: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/**
 * whisper.cpp for speech-in, Piper for speech-out, both as local processes.
 *
 * The reason this engine exists at all: nothing leaves the machine. Dictated
 * PHI goes to a temp file, into a local binary, and back out — no vendor, no
 * BAA, no disclosure to account for.
 */
export class LocalSpeechProvider implements SpeechProvider {
  readonly name = "local";
  readonly runsInBrowser = false;

  constructor(
    private cfg: SpeechConfig,
    private env: SpeechEnv = process.env,
  ) {}

  async transcribe(audio: Buffer, mimeType: string, hints?: string[]): Promise<TranscriptResult> {
    const local = this.cfg.local;
    const problem = checkWhisperPrereqs(local, this.env);
    if (problem) return { text: "", error: problem };

    // Temp dir per call, removed in the finally: whisper writes a sidecar .txt
    // next to its input, and a transcript of PHI left in /tmp is exactly the
    // kind of residue speech.consent.retainAudio exists to prevent.
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "orion-stt-"));
      const audioPath = join(dir, `input.${extensionFor(mimeType)}`);
      await writeFile(audioPath, audio);

      const bin = resolveBinary(local.whisperBin, this.env) ?? local.whisperBin;
      const result = await run(bin, buildWhisperArgs(local, audioPath, hints));
      if (result.error) {
        return {
          text: "",
          error: `Could not run whisper.cpp at "${local.whisperBin}" (config field speech.local.whisperBin): ${result.error}`,
        };
      }
      if (result.code !== 0) {
        return { text: "", error: `whisper.cpp exited ${result.code}: ${lastLines(result.stderr)}` };
      }

      // Prefer the sidecar it was told to write; fall back to stdout, which is
      // what older builds produce when --output-txt is unsupported.
      let raw = result.stdout;
      try {
        raw = await readFile(`${outputPrefix(audioPath)}.txt`, "utf8");
      } catch {
        /* stdout it is */
      }
      const text = parseWhisperOutput(raw);
      if (!text) return { text: "", error: "No speech was recognized in the recording." };
      return { text };
    } catch (err) {
      return { text: "", error: `Local transcription failed: ${(err as Error).message}` };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async synthesize(text: string): Promise<SynthesisResult> {
    const local = this.cfg.local;
    const problem = checkPiperPrereqs(local, this.env);
    if (problem) return { error: problem };

    const spoken = text.slice(0, this.cfg.maxSpokenChars);
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "orion-tts-"));
      const outPath = join(dir, "speech.wav");
      const bin = resolveBinary(local.piperBin, this.env) ?? local.piperBin;
      const result = await run(bin, buildPiperArgs(local, outPath), spoken);
      if (result.error) {
        return {
          error: `Could not run Piper at "${local.piperBin}" (config field speech.local.piperBin): ${result.error}`,
        };
      }
      if (result.code !== 0) return { error: `Piper exited ${result.code}: ${lastLines(result.stderr)}` };
      const audio = await readFile(outPath);
      return { audio, mimeType: "audio/wav" };
    } catch (err) {
      return { error: `Local synthesis failed: ${(err as Error).message}` };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  capabilities(): SpeechCapabilities {
    return {
      stt: true,
      tts: true,
      // whisper.cpp here is invoked per utterance on a finished file; partial
      // results would need its streaming mode and a long-lived process.
      streaming: false,
      // As whisper's `--prompt` initial-prompt conditioning.
      acceptsHints: true,
      note: "Whole-utterance only: audio is written to a temp file, transcribed, and the file is deleted.",
    };
  }

  describe(): string {
    return [
      "local (whisper.cpp + Piper) — speech recognition and synthesis run as processes on this machine.",
      "  PRIVACY: no audio, transcript, or spoken reply leaves this host. No vendor, no BAA needed, nothing to disclose.",
      `  whisper: ${this.cfg.local.whisperBin} (speech.local.whisperBin), model ${this.cfg.local.whisperModel}`,
      `  piper:   ${this.cfg.local.piperBin} (speech.local.piperBin), voice ${this.cfg.local.piperVoice}`,
      `  mode=${this.cfg.mode}  wakeWord="${this.cfg.wakeWord}"  speakReplies=${this.cfg.speakReplies}`,
    ].join("\n");
  }
}

/** Whisper picks its decoder from the file extension, so the temp file needs one. */
export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/flac": "flac",
  };
  return map[mimeType.split(";")[0]!.trim().toLowerCase()] ?? "wav";
}

function lastLines(stderr: string, count = 3): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-count).join(" | ") || "(no output)";
}
