// ── Voice interface ──────────────────────────────────────────────────────────
//
// Talking to AetheraClaw at a desk. Deliberately NOT the same thing as
// src/voice/ on the server, which dials payers — that module navigates an IVR
// over text segments and never touches audio. This file is the only place in
// the product that opens a microphone.
//
// It is loaded after app.js and reaches three of its globals — `state`, `send`
// and `respondApproval` — plus the `aethera:event` seam. It never wraps the
// socket: if this file is removed, the chat client is unchanged.
//
// Three engines, chosen server-side and reported by /api/speech/config:
//   browser  recognition and synthesis happen HERE, in the page
//   local    audio is posted to the gateway, which runs whisper.cpp / Piper
//   cloud    audio is posted to the gateway, which calls a vendor
// Only the browser engine touches SpeechRecognition; the other two record with
// MediaRecorder and let the server decide. One capture path, three sinks.

(() => {
  "use strict";

  const V = {
    cfg: null,
    // idle → listening → thinking → speaking. Drives the pill and nothing else;
    // the real state of the turn lives in app.js.
    phase: "idle",
    recognition: null,
    recorder: null,
    chunks: [],
    stream: null,
    audio: null,
    // Text of the reply in flight, accumulated from text_delta. app.js resets
    // its own bubble on every tool call, so its dataset.raw is not the whole
    // answer — this is.
    reply: "",
    // What has streamed in but is not yet a complete, speakable sentence.
    pending: "",
    // Ordered chunks waiting their turn at the speaker.
    queue: [],
    draining: false,
    spokenChars: 0,
    consented: false,
    wakeActive: false,
    heldKey: false,
    awaitingApproval: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ── Consent ────────────────────────────────────────────────────────────────
  // Asked once per browser session, and the text names the ACTUAL destination
  // of the audio rather than saying "voice input may be processed". Under the
  // browser engine that destination is Google, which is the fact a clinic needs
  // before it decides, and burying it would make the dialog decorative.

  function consentText(cfg) {
    if (cfg.engine === "browser") {
      return [
        "This uses your browser's built-in speech recognition.",
        "Chrome and Edge send the captured audio to Google's servers to transcribe it.",
        "That is outside this machine, so do not speak real patient identifiers.",
      ];
    }
    if (cfg.engine === "local") {
      return [
        "Audio is sent to the AetheraClaw gateway on this machine and transcribed locally by Whisper.",
        "Nothing leaves this computer.",
        cfg.retainAudio ? "Captured audio IS retained on disk." : "Captured audio is transcribed and discarded, never written to disk.",
      ];
    }
    return [
      "Audio is sent to the AetheraClaw gateway, which forwards it to a third-party speech vendor.",
      "That is outside this machine, so do not speak real patient identifiers.",
      cfg.retainAudio ? "Captured audio IS retained on disk." : "Captured audio is discarded after transcription.",
    ];
  }

  async function ensureConsent() {
    if (V.consented) return true;
    if (!V.cfg.requireAcknowledgement) {
      V.consented = true;
      return true;
    }
    if (sessionStorage.getItem("aethera.voice.consent") === V.cfg.engine) {
      V.consented = true;
      return true;
    }
    const lines = consentText(V.cfg).join("\n\n");
    const ok = window.confirm(`Microphone — ${V.cfg.engine} engine\n\n${lines}\n\nTurn the microphone on?`);
    if (ok) {
      sessionStorage.setItem("aethera.voice.consent", V.cfg.engine);
      V.consented = true;
    }
    return ok;
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────

  function mount() {
    const box = document.querySelector(".composer .box");
    if (!box) return;

    const mic = document.createElement("button");
    mic.className = "attach mic";
    mic.id = "mic";
    mic.type = "button";
    mic.textContent = "🎙";
    mic.title = "Hold to talk (or hold Ctrl+Space). Click to toggle.";
    box.insertBefore(mic, $("#send"));

    const pill = document.createElement("div");
    pill.className = "voice-pill";
    pill.id = "voice-pill";
    pill.hidden = true;
    pill.innerHTML = '<span class="dot"></span><span id="voice-label">listening</span>';
    document.body.appendChild(pill);

    // Press-and-hold is the primary gesture; a plain click toggles for anyone
    // who would rather not hold a button through a long sentence.
    let held = false;
    mic.addEventListener("pointerdown", () => {
      held = false;
      V.holdTimer = setTimeout(() => {
        held = true;
        startListening();
      }, 180);
    });
    const release = () => {
      clearTimeout(V.holdTimer);
      if (held) stopListening();
      held = false;
    };
    mic.addEventListener("pointerup", release);
    mic.addEventListener("pointerleave", release);
    mic.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (held) return;
      if (V.phase === "listening") stopListening();
      else startListening();
    });

    // Ctrl+Space, not bare Space: the composer is a textarea and a space is a
    // space. Holding a modifier is also what stops a wake word firing every
    // time somebody types.
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && e.ctrlKey && !V.heldKey) {
        e.preventDefault();
        V.heldKey = true;
        startListening();
      }
      // Escape cuts a spoken reply dead. The commonest thing anyone wants from
      // a talking computer is for it to stop talking.
      if (e.key === "Escape") stopSpeaking();
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space" && V.heldKey) {
        V.heldKey = false;
        stopListening();
      }
    });
  }

  function setPhase(phase, label) {
    V.phase = phase;
    const pill = $("#voice-pill");
    const mic = $("#mic");
    if (!pill || !mic) return;
    pill.hidden = phase === "idle";
    pill.dataset.phase = phase;
    const text = $("#voice-label");
    if (text) text.textContent = label || phase;
    mic.classList.toggle("on", phase === "listening");
    mic.classList.toggle("speaking", phase === "speaking");
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  async function startListening() {
    if (!V.cfg?.enabled) return;
    if (V.phase === "listening") return;
    if (!(await ensureConsent())) return;
    // Barge-in: talking over the assistant stops it. Without this the
    // microphone hears the speakers and transcribes the reply back as a
    // question, which is a loop rather than a conversation.
    stopSpeaking();
    if (V.cfg.runsInBrowser) startBrowserRecognition();
    else startRecording();
  }

  function stopListening() {
    if (V.recognition) {
      try {
        V.recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    if (V.recorder && V.recorder.state === "recording") V.recorder.stop();
    if (V.phase === "listening") setPhase("idle");
  }

  /**
   * Bias recognition toward the vocabulary this practice actually uses.
   *
   * Generic speech recognition has never heard of "Availity" or "J1885", and
   * gets them wrong every time until told they exist. The grammar is built
   * server-side from the codes the practice bills and the payers it works, and
   * is fetched once per session.
   *
   * SpeechGrammarList is not implemented everywhere and is advisory where it
   * is, so every step here is guarded — a browser without it recognises exactly
   * as well as it did before, which is the point of it being a hint.
   */
  function applyHints(rec) {
    const GL = window.SpeechGrammarList || window.webkitSpeechGrammarList;
    if (!GL || !V.grammar) return;
    try {
      const list = new GL();
      list.addFromString(V.grammar, 1);
      rec.grammars = list;
    } catch {
      /* advisory only */
    }
  }

  async function loadHints() {
    try {
      const res = await fetch("/api/speech/vocabulary");
      if (!res.ok) return;
      const data = await res.json();
      V.grammar = data.grammar || "";
      V.hintCount = data.count ?? 0;
    } catch {
      /* recognition still works unbiased */
    }
  }

  function startBrowserRecognition() {
    if (!SR) {
      note("This browser has no speech recognition. Chrome or Edge, or switch speech.engine to local/cloud.");
      return;
    }
    const rec = new SR();
    V.recognition = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    applyHints(rec);
    let finalText = "";
    rec.addEventListener("result", (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      preview(finalText + interim);
    });
    rec.addEventListener("error", (ev) => {
      note(ev.error === "not-allowed" ? "Microphone permission was refused." : `Speech error: ${ev.error}`);
      setPhase("idle");
    });
    rec.addEventListener("end", () => {
      V.recognition = null;
      if (finalText.trim()) submitTranscript(finalText.trim());
      else setPhase("idle");
    });
    try {
      rec.start();
      setPhase("listening", "listening");
    } catch {
      setPhase("idle");
    }
  }

  async function startRecording() {
    try {
      V.stream = V.stream || (await navigator.mediaDevices.getUserMedia({ audio: true }));
    } catch {
      note("Microphone permission was refused.");
      return;
    }
    const rec = new MediaRecorder(V.stream);
    V.recorder = rec;
    V.chunks = [];
    rec.addEventListener("dataavailable", (e) => e.data.size && V.chunks.push(e.data));
    rec.addEventListener("stop", async () => {
      V.recorder = null;
      const blob = new Blob(V.chunks, { type: rec.mimeType || "audio/webm" });
      V.chunks = [];
      if (blob.size < 1200) {
        setPhase("idle");
        return;
      }
      setPhase("thinking", "transcribing");
      try {
        const res = await fetch(`/api/speech/transcribe?mime=${encodeURIComponent(blob.type)}`, {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob,
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          note(data.error || `transcription failed (${res.status})`);
          setPhase("idle");
          return;
        }
        if (data.text?.trim()) submitTranscript(data.text.trim());
        else setPhase("idle");
      } catch (err) {
        note(`transcription failed: ${err.message}`);
        setPhase("idle");
      }
    });
    rec.start();
    setPhase("listening", "listening");
  }

  /** Show what was heard in the composer as it is heard, so a misread is visible before it is sent. */
  function preview(text) {
    const input = $("#input");
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event("input"));
  }

  /**
   * Run a browser-recognised transcript through the same server pipeline the
   * posted-audio path already gets.
   *
   * The browser engine recognises in the page, so without this call its
   * transcripts would skip the identifier gate and the code validation
   * entirely — the one engine that most needs them, since its audio has
   * already left the machine. One implementation, two entry points.
   */
  async function refine(text) {
    try {
      // The session id travels with it so the §164.312(b) entry points at a
      // real conversation. Without it every spoken identifier logs against
      // "unknown", which is a record that an access happened and no way to
      // find it again — the half of an audit log that has no value.
      const url = state.sessionId
        ? `/api/speech/refine?session=${encodeURIComponent(state.sessionId)}`
        : "/api/speech/refine";
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: text,
      });
      if (!res.ok) return { text };
      return await res.json();
    } catch {
      return { text };
    }
  }

  async function submitTranscript(raw) {
    setPhase("idle");
    const refined = await refine(raw);
    const text = refined.text ?? raw;
    // An ambiguous code is a QUESTION, not a guess. The transcript goes in the
    // composer with the question on screen, and nothing is sent until a human
    // resolves it — snapping "99213" to "99214" silently is the failure the
    // whole validation step exists to prevent.
    if (refined.ask) {
      preview(text);
      note(refined.ask);
      return;
    }
    if (refined.blocked) {
      note(refined.why || "That looked like it carried a patient identifier, so it was not sent.");
      return;
    }
    if (refined.why) note(refined.why);
    // Approval by voice: while a confirmation is on screen, an utterance is an
    // ANSWER to it, not a new request. Anything that is not clearly yes or no
    // falls through to the composer rather than being guessed — a misheard
    // "approve" would run a tool nobody authorised.
    if (V.awaitingApproval) {
      const yes = /\b(approve|approved|yes|yeah|confirm|go ahead|do it)\b/i.test(text);
      const no = /\b(deny|denied|no|nope|cancel|stop|reject)\b/i.test(text);
      if (yes !== no) {
        V.awaitingApproval = null;
        if (typeof respondApproval === "function") respondApproval(yes);
        return;
      }
      note(`Heard "${text}" — say approve or deny.`);
      return;
    }
    preview(text);
    if (typeof send === "function") send();
  }

  // ── Speaking ───────────────────────────────────────────────────────────────

  function stopSpeaking() {
    // Clear the queue FIRST. Cancelling the current utterance while chunks are
    // still queued means the next one starts a beat later, so the interruption
    // appears not to have worked — the commonest complaint about talking
    // software, and the reason barge-in has to empty the whole pipeline.
    V.queue.length = 0;
    V.draining = false;
    V.pending = "";
    V.spokenChars = 0;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* not supported */
    }
    if (V.audio) {
      V.audio.pause();
      V.audio = null;
    }
    if (V.phase === "speaking") setPhase("idle");
  }

  // ── Sentence chunking ──────────────────────────────────────────────────────
  // Perceived latency is dominated by waiting for the whole answer before any
  // sound. Speaking each sentence as it closes turns a six-second silence into
  // roughly one, and costs nothing on the model side — the tokens were already
  // streaming.

  /** A sentence ends at terminal punctuation followed by space or end-of-buffer. */
  const SENTENCE_END = /[.!?](?=["')\]]*(?:\s|$))/g;

  /**
   * Split off whatever is safely speakable, leaving the rest buffered.
   *
   * Two things are deliberately held back. A fence that has opened and not
   * closed means a code block is mid-stream, and speaking half of one is worse
   * than waiting. And a trailing fragment with no terminal punctuation is a
   * sentence still being written — speaking it would cut a clause in half.
   */
  function takeSpeakable(buffer, final) {
    const fences = (buffer.match(/```/g) || []).length;
    if (fences % 2 === 1 && !final) return { chunk: "", rest: buffer };
    if (final) return { chunk: buffer, rest: "" };

    SENTENCE_END.lastIndex = 0;
    let cut = -1;
    for (let m = SENTENCE_END.exec(buffer); m !== null; m = SENTENCE_END.exec(buffer)) cut = m.index + 1;
    // A very short first sentence ("Yes.") is worth speaking immediately; a
    // trailing fragment is not. The threshold only guards against chattering
    // one word at a time when a reply is a list of short lines.
    if (cut < 0 || cut < 12) return { chunk: "", rest: buffer };
    return { chunk: buffer.slice(0, cut), rest: buffer.slice(cut) };
  }

  function flushSpeech(final) {
    if (!V.cfg?.speakReplies) return;
    const { chunk, rest } = takeSpeakable(V.pending, final);
    V.pending = rest;
    const text = chunk.trim();
    if (text) enqueueSpeak(text);
  }

  // ── The speech queue ───────────────────────────────────────────────────────
  // Chunks must be spoken in order, and each needs an async normalization round
  // trip before it can be spoken. Firing those off as they arrive would let a
  // short later chunk overtake a long earlier one and deliver the answer out of
  // order, so the queue is drained strictly one at a time.

  /**
   * `urgent` jumps the queue and ignores the spoken-length budget.
   *
   * An approval prompt is the one thing that must not wait behind three
   * buffered sentences or be silently dropped because a long answer already
   * spent the budget — the turn has stopped and is waiting on an answer, so
   * anything still queued is about to be stale anyway.
   */
  function enqueueSpeak(text, { urgent = false } = {}) {
    if (!text) return;
    if (urgent) {
      V.queue.length = 0;
      V.pending = "";
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* not supported */
      }
      V.queue.push(text);
      if (!V.draining) void drainQueue();
      return;
    }
    const budget = V.cfg?.maxSpokenChars ?? 1200;
    if (V.spokenChars >= budget) return;
    V.spokenChars += text.length;
    V.queue.push(text);
    if (!V.draining) void drainQueue();
  }

  async function drainQueue() {
    V.draining = true;
    while (V.queue.length > 0) {
      const next = V.queue.shift();
      // stopSpeaking() empties the queue and clears this flag; if that happened
      // while the previous chunk was in flight, stop rather than speaking one
      // more sentence after the user asked for silence.
      if (!V.draining) return;
      await speakOne(next);
    }
    V.draining = false;
    if (V.phase === "speaking") setPhase("idle");
    resumeWake();
  }

  /**
   * Speak markdown, correctly.
   *
   * The normalization is a server round trip on purpose. "99213" has to be read
   * "nine nine two one three" — a TTS engine says "ninety-nine thousand two
   * hundred thirteen", which is not a code any biller recognises — and that rule
   * plus the money, date and abbreviation rules are domain logic with tests
   * beside them on the server. Reimplementing them here in untested JS is how
   * the two drift.
   */
  async function speakOne(markdown) {
    if (!markdown.trim()) return;
    let text = markdown;
    try {
      const res = await fetch("/api/speech/speakable", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: markdown,
      });
      if (res.ok) {
        const data = await res.json();
        text = data.text || markdown;
      }
    } catch {
      /* fall back to the raw text rather than staying silent */
    }
    if (!text.trim() || !V.draining) return;

    setPhase("speaking", "speaking");

    if (V.cfg.runsInBrowser) {
      if (!window.speechSynthesis) return;
      await new Promise((resolve) => {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "en-US";
        // Resolve on error too, or one failed utterance stalls the queue and
        // the rest of the answer is never spoken.
        utter.addEventListener("end", resolve, { once: true });
        utter.addEventListener("error", resolve, { once: true });
        window.speechSynthesis.speak(utter);
      });
      return;
    }

    try {
      const res = await fetch("/api/speech/synthesize", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: text,
      });
      if (!res.ok) return;
      const buf = await res.blob();
      await new Promise((resolve) => {
        const audio = new Audio(URL.createObjectURL(buf));
        V.audio = audio;
        audio.addEventListener("ended", () => {
          V.audio = null;
          resolve();
        }, { once: true });
        audio.addEventListener("error", resolve, { once: true });
        audio.play().catch(resolve);
      });
    } catch {
      /* a chunk that will not synthesize is skipped, not fatal to the rest */
    }
  }

  // ── Tool narration ─────────────────────────────────────────────────────────
  // Silence during a ten-second tool call reads as a crash. The clause comes
  // from the server, where the verb map lives beside its tests and where the
  // rule that arguments are never spoken is enforced — a tool input can carry
  // an identifier, and this goes to a speaker in a room.

  const narrationCache = new Map();

  async function narrate(toolName) {
    if (!V.cfg?.speakReplies) return;
    if (narrationCache.has(toolName)) {
      const cached = narrationCache.get(toolName);
      if (cached) enqueueSpeak(cached);
      return;
    }
    try {
      const res = await fetch(`/api/speech/narrate?tool=${encodeURIComponent(toolName)}`);
      if (!res.ok) return;
      const data = await res.json();
      const clause = data.narrate ? data.text : "";
      narrationCache.set(toolName, clause);
      if (clause) enqueueSpeak(clause);
    } catch {
      /* narration is a courtesy; losing it must not affect the turn */
    }
  }

  // ── Wake word ──────────────────────────────────────────────────────────────
  // Opt-in, and only under the browser engine: always-on over MediaRecorder
  // would mean streaming continuous audio off the machine to detect one phrase,
  // which is a far larger exposure than the feature is worth.

  function startWake() {
    if (V.cfg.mode !== "always-on" || !V.cfg.runsInBrowser || !SR) return;
    if (V.wakeActive) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    V.wake = rec;
    V.wakeActive = true;
    const wake = (V.cfg.wakeWord || "hey aethera").toLowerCase();
    rec.addEventListener("result", (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const said = ev.results[i][0].transcript.toLowerCase();
        if (said.includes(wake)) {
          const after = said.split(wake).pop().trim();
          stopWake();
          if (after) submitTranscript(after);
          else startListening();
          return;
        }
      }
    });
    // A continuous recogniser stops itself on silence; restart unless something
    // deliberately turned it off, or always-on lasts about a minute.
    rec.addEventListener("end", () => {
      if (V.wakeActive) {
        try {
          rec.start();
        } catch {
          V.wakeActive = false;
        }
      }
    });
    rec.addEventListener("error", () => {
      V.wakeActive = false;
    });
    try {
      rec.start();
    } catch {
      V.wakeActive = false;
    }
  }

  function stopWake() {
    V.wakeActive = false;
    try {
      V.wake?.stop();
    } catch {
      /* already stopped */
    }
  }

  function resumeWake() {
    if (V.cfg?.mode === "always-on") startWake();
  }

  function note(message) {
    const hint = $("#hint");
    if (hint) {
      hint.textContent = message;
      setTimeout(() => {
        hint.textContent =
          "Verdicts are computed server-side, where they are tested. Raw telemetry is one toggle away. Anything risky asks first.";
      }, 6000);
    }
  }

  // ── The stream ─────────────────────────────────────────────────────────────

  window.addEventListener("aethera:event", (ev) => {
    const e = ev.detail;
    if (!V.cfg?.enabled) return;
    switch (e.type) {
      case "turn_started":
        V.reply = "";
        V.pending = "";
        V.queue.length = 0;
        V.spokenChars = 0;
        setPhase("thinking", "working");
        break;
      case "text_delta":
        V.reply += e.text;
        V.pending += e.text;
        flushSpeech(false);
        break;
      case "tool_call":
        // Plumbing is filtered server-side: narrating the tool-search machinery
        // is noise about the system rather than progress on the question.
        void narrate(e.toolName);
        break;
      case "approval_request":
        // Spoken confirmation still shows the dialog — the buttons remain the
        // authority. Voice is a second way to answer it, never a replacement
        // for seeing what is about to run.
        V.awaitingApproval = e.approvalId;
        // The tool NAME and its stated reason, never `e.input` — an argument
        // can carry an identifier and this comes out of a speaker.
        enqueueSpeak(`Approval needed. ${e.toolName}. ${e.description || ""} Say approve or deny.`, { urgent: true });
        break;
      case "approval_resolved":
        V.awaitingApproval = null;
        break;
      case "turn_completed":
        // Everything up to the last complete sentence has already been spoken
        // while it streamed; this says whatever tail was still buffered.
        flushSpeech(true);
        break;
      case "error":
        setPhase("idle");
        break;
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────

  async function boot() {
    try {
      const res = await fetch("/api/speech/config");
      V.cfg = await res.json();
    } catch {
      return;
    }
    if (!V.cfg?.enabled) return;
    mount();
    await loadHints();
    if (V.cfg.mode === "always-on") startWake();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
