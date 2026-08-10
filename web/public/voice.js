// ── Voice interface ──────────────────────────────────────────────────────────
//
// Talking to Orion at a desk. Deliberately NOT the same thing as
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
    // The raw markdown already spoken, so "tell me more" resumes rather than repeats.
    spokenText: "",
    brief: false,
    hasMore: false,
    consented: false,
    wakeActive: false,
    vad: null,
    wake: null,
    heldKey: false,
    awaitingApproval: null,
    worklist: false,
    awaitingChallenge: false,
    pendingRisk: "",
    pendingTool: "",
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
        "Audio is sent to the Orion gateway on this machine and transcribed locally by Whisper.",
        "Nothing leaves this computer.",
        cfg.retainAudio ? "Captured audio IS retained on disk." : "Captured audio is transcribed and discarded, never written to disk.",
      ];
    }
    return [
      "Audio is sent to the Orion gateway, which forwards it to a third-party speech vendor.",
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

  /**
   * The mic button when speech is turned OFF.
   *
   * Previously this file simply returned from boot() when the server said
   * disabled, so nothing was mounted at all: no button, no menu item, no
   * message. From the outside that is indistinguishable from a product with no
   * voice interface — the feature exists, is tested, and is invisible.
   *
   * So the affordance is always present and says which it is. A control that is
   * visibly off teaches the reader that the capability exists and how to turn
   * it on; a control that is absent teaches them nothing.
   */
  function mountDisabled() {
    const box = document.querySelector(".composer .box");
    if (!box) return;
    const mic = document.createElement("button");
    mic.className = "attach mic off";
    mic.id = "mic";
    mic.type = "button";
    mic.textContent = "🎙";
    mic.title = "Voice is turned off in this deployment — click for why.";
    mic.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.alert(
        "Voice is turned off in this deployment.\n\n" +
          (V.cfg?.status || "") +
          "\n\nTo turn it on, set ORION_SPEECH=1 (and optionally ORION_SPEECH_ENGINE) " +
          "in the environment, or speech.enabled in config.json5.",
      );
    });
    box.insertBefore(mic, $("#send"));
  }

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
      const heard = finalText + interim;
      preview(heard);
      if (/\d/.test(heard)) void prefetch(heard);
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

  /**
   * Look up a code from a PARTIAL utterance, while the speaker is still talking.
   *
   * Only codes that certainly exist come back — a near miss returns nothing,
   * because mid-sentence the recognizer is still revising and correcting
   * someone's half-said code is worse than showing nothing. Results are
   * discarded silently when the final transcript disagrees.
   */
  let prefetchAt = 0;
  async function prefetch(partial) {
    if (!V.cfg?.enabled || V.cfg.prefetch === false) return;
    const now = Date.now();
    if (now - prefetchAt < 400) return;
    prefetchAt = now;
    try {
      const res = await fetch("/api/speech/prefetch", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: partial,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.hint && V.phase === "listening") note(data.hint);
    } catch {
      /* speculative by definition — a failure costs nothing */
    }
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
  /**
   * What is on screen right now, as rows the resolver can name.
   *
   * Read from the canvas because that is where a worklist or a result table is
   * actually rendered. Bounded hard: this rides along with every spoken turn,
   * and pasting a whole table into every request would cost more than the
   * feature is worth.
   */
  function screenContext() {
    const canvas = $("#canvas");
    if (!canvas || canvas.hidden) return undefined;
    const rows = [...canvas.querySelectorAll("tbody tr")].slice(0, 20).map((tr, i) => ({
      id: tr.dataset.id || tr.querySelector("td")?.textContent?.trim() || String(i + 1),
      label: [...tr.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent.trim()).filter(Boolean).join(" · "),
      index: i + 1,
    })).filter((r) => r.label);
    if (rows.length === 0) return undefined;
    const selected = canvas.querySelector("tbody tr.selected");
    return {
      title: $("#canvas-title")?.textContent?.trim() || "",
      rows,
      selectedId: selected ? (selected.dataset.id || rows[[...canvas.querySelectorAll("tbody tr")].indexOf(selected)]?.id) : undefined,
    };
  }

  async function refine(text) {
    try {
      // The session id travels with it so the §164.312(b) entry points at a
      // real conversation. Without it every spoken identifier logs against
      // "unknown", which is a record that an access happened and no way to
      // find it again — the half of an audit log that has no value.
      const url = state.sessionId
        ? `/api/speech/refine?session=${encodeURIComponent(state.sessionId)}`
        : "/api/speech/refine";
      const screen = screenContext();
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": screen ? "application/json" : "text/plain" },
        body: screen ? JSON.stringify({ text, screen }) : text,
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
    // Worklist mode owns the utterance while it is active: in that mode "next"
    // means the cursor, not a question for the model.
    if (V.worklist) {
      void worklistCommand(text);
      return;
    }
    if (/^\s*(start|begin|open|work)( the)? worklist\b/i.test(text) || /^\s*worklist mode\b/i.test(text)) {
      void worklistStart();
      return;
    }
    // Answered here, not sent. "Tell me more" is about the reply already on
    // screen; forwarding it would make the model answer the question again
    // rather than finish reading out the answer it already gave.
    if (/^\s*(tell me more|go on|continue|read the rest|the rest)\b/i.test(text)) {
      tellMore();
      return;
    }
    // Approval by voice: while a confirmation is on screen, an utterance is an
    // ANSWER to it, not a new request. Anything that is not clearly yes or no
    // falls through to the composer rather than being guessed — a misheard
    // "approve" would run a tool nobody authorised.
    if (V.awaitingChallenge) {
      void answerChallenge(text);
      return;
    }
    if (V.awaitingApproval) {
      const yes = /\b(approve|approved|yes|yeah|confirm|go ahead|do it)\b/i.test(text);
      const no = /\b(deny|denied|no|nope|cancel|stop|reject)\b/i.test(text);
      if (yes !== no) {
        // Denial never needs a challenge — stopping something is always allowed.
        if (!yes) {
          V.awaitingApproval = null;
          if (typeof respondApproval === "function") respondApproval(false);
          return;
        }
        void approveWithAuthorization();
        return;
      }
      note(`Heard "${text}" — say approve or deny.`);
      return;
    }
    preview(text);
    if (typeof send === "function") send();
  }

  // ── Spoken authorization ───────────────────────────────────────────────────
  // Saying "approve" out loud is one word, and anyone in the room can say it.
  // Risky actions ask for a phrase first.
  //
  // What this is: a knowledge factor. It checks that whoever spoke knows the
  // authorization phrase — NOT who they are. There is no voiceprint here and
  // the console does not pretend otherwise; anyone who has overheard the
  // phrase can repeat it. The approval dialog on screen remains the authority.

  async function approveWithAuthorization() {
    const q = state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : "";
    try {
      const res = await fetch(
        `/api/speech/authorization${q}${q ? "&" : "?"}tool=${encodeURIComponent(V.pendingTool)}&risk=${encodeURIComponent(V.pendingRisk)}`,
      );
      const info = res.ok ? await res.json() : { required: false };
      // Not required, already inside the window, or no phrase configured on
      // this install: behave exactly as before rather than blocking somebody
      // out of their own approval.
      if (!info.required || info.authorized || !info.configured) {
        V.awaitingApproval = null;
        if (typeof respondApproval === "function") respondApproval(true);
        return;
      }
      const ch = await fetch(`/api/speech/authorization/challenge${q}`, { method: "POST" });
      if (!ch.ok) {
        V.awaitingApproval = null;
        if (typeof respondApproval === "function") respondApproval(true);
        return;
      }
      const challenge = await ch.json();
      V.awaitingChallenge = true;
      enqueueSpeak(challenge.prompt, { urgent: true });
      note(challenge.prompt);
    } catch {
      // A failure here must not strand the approval; the screen still works.
      note("Could not start the authorization challenge — use the buttons.");
    }
  }

  async function answerChallenge(spoken) {
    const q = state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : "";
    try {
      const res = await fetch(`/api/speech/authorization/verify${q}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: spoken,
      });
      const out = await res.json();
      if (out.ok) {
        V.awaitingChallenge = false;
        V.awaitingApproval = null;
        if (typeof respondApproval === "function") respondApproval(true);
        return;
      }
      // The challenge stays open on a wrong answer; the server counts attempts
      // and locks out, so retrying here cannot become unlimited guessing.
      note(out.why || "That was not the authorization phrase.");
      enqueueSpeak(out.why || "That was not right.", { urgent: true });
    } catch {
      V.awaitingChallenge = false;
      note("Authorization could not be checked — use the buttons.");
    }
  }

  // ── Worklist mode ──────────────────────────────────────────────────────────
  // A cursor over the open worklist driven by about six words. The grammar is
  // CLOSED server-side: an utterance either is one of the known commands or it
  // is unrecognized and the state does not move. A near-guess here is not a bad
  // answer, it is an action on somebody else's claim.

  const wlUrl = (path) =>
    state.sessionId ? `${path}?session=${encodeURIComponent(state.sessionId)}` : path;

  async function worklistStart() {
    try {
      const res = await fetch(wlUrl("/api/speech/worklist/start"), { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      V.worklist = data.active === true && data.total > 0;
      enqueueSpeak(data.say, { urgent: true });
      if (!V.worklist) note("Nothing open on the worklist.");
    } catch {
      note("Could not open the worklist.");
    }
  }

  async function worklistCommand(text) {
    try {
      const res = await fetch(wlUrl("/api/speech/worklist/command"), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: text,
      });
      if (!res.ok) {
        V.worklist = false;
        return;
      }
      const step = await res.json();
      if (step.ended) V.worklist = false;
      if (step.say) enqueueSpeak(step.say, { urgent: true });
      // An action needs the agent. The instruction names the claim explicitly —
      // the model is never asked to resolve a pronoun in this mode.
      if (step.send) {
        preview(step.send);
        if (typeof send === "function") send();
      }
    } catch {
      V.worklist = false;
    }
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

  /**
   * Brief mode speaks the FIRST sentence and holds the rest.
   *
   * Which is both halves of what is wanted at once: the headline arrives as
   * fast as streaming can deliver it, and the four paragraphs behind it do not
   * get read out to a room. The screen still has everything, so nothing is
   * lost — and "tell me more" is there for the times it matters.
   */
  function flushSpeech(final) {
    if (!V.cfg?.speakReplies) return;
    if (V.brief && V.spokenChars > 0) {
      // Everything past the first sentence is available, just not spoken.
      if (V.pending.trim()) V.hasMore = true;
      return;
    }
    const { chunk, rest } = takeSpeakable(V.pending, final);
    V.pending = rest;
    const text = chunk.trim();
    if (text) enqueueSpeak(text);
  }

  /** Speak everything that brief mode held back. */
  function tellMore() {
    const spokenPrefix = V.spokenText || "";
    const rest = V.reply.startsWith(spokenPrefix) ? V.reply.slice(spokenPrefix.length) : V.reply;
    V.hasMore = false;
    if (!rest.trim()) {
      note("That was all of it.");
      return;
    }
    // Deliberately bypasses the brief check — this IS the explicit ask for it.
    const wasBrief = V.brief;
    V.brief = false;
    enqueueSpeak(rest.trim());
    V.brief = wasBrief;
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
    V.spokenText = (V.spokenText || "") + text;
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
      // Brief mode applies to the WHOLE reply, not to each streamed sentence —
      // summarising every chunk independently would say the same headline four
      // times. Chunks stream in full; the summary is applied at the end.
      const res = await fetch("/api/speech/speakable?verbosity=full", {
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

  /**
   * A local energy gate in front of the recognizer.
   *
   * This is the whole point of the item. Always-on used to mean a continuous
   * SpeechRecognition session, and under the browser engine that streams the
   * room to Google for as long as the tab is open — including the silence, and
   * including every conversation that is not addressed to the computer.
   *
   * The gate runs entirely in the page over the Web Audio API: it measures
   * loudness and nothing else, never buffers audio, and never sends anything.
   * The recognizer is only started once somebody is actually speaking, and is
   * stopped again when they stop. Silence costs nothing and leaves nowhere.
   *
   * It is a loudness gate, not speech detection — it cannot tell talking from a
   * door closing. That is the honest limit, and it is the right trade: the
   * expensive failure was streaming continuously, and a gate that occasionally
   * opens on a noise still closes again a second later.
   */
  const VAD_RMS_THRESHOLD = 0.018;
  const VAD_SILENCE_MS = 1200;

  async function startVad(onSpeech, onSilence) {
    try {
      V.stream = V.stream || (await navigator.mediaDevices.getUserMedia({ audio: true }));
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(V.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      V.vad = { ctx, analyser, speaking: false, quietSince: 0, stop: false };

      const tick = () => {
        if (V.vad?.stop) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms > VAD_RMS_THRESHOLD) {
          V.vad.quietSince = 0;
          if (!V.vad.speaking) {
            V.vad.speaking = true;
            onSpeech();
          }
        } else if (V.vad.speaking) {
          if (!V.vad.quietSince) V.vad.quietSince = now;
          else if (now - V.vad.quietSince > VAD_SILENCE_MS) {
            V.vad.speaking = false;
            V.vad.quietSince = 0;
            onSilence();
          }
        }
        requestAnimationFrame(tick);
      };
      tick();
      return true;
    } catch {
      return false;
    }
  }

  function stopVad() {
    if (!V.vad) return;
    V.vad.stop = true;
    try {
      V.vad.ctx.close();
    } catch {
      /* already closed */
    }
    V.vad = null;
  }

  async function startWake() {
    if (V.cfg.mode !== "always-on" || !V.cfg.runsInBrowser || !SR) return;
    if (V.wakeActive) return;
    V.wakeActive = true;

    // The recognizer is created on demand, only while somebody is speaking.
    const gated = await startVad(
      () => openWakeRecognizer(),
      () => closeWakeRecognizer(),
    );
    // No microphone or no Web Audio: fall back to the old continuous listener
    // rather than silently doing nothing, and say so, because the privacy
    // posture is different and the operator should know which one they have.
    if (!gated) {
      note("Always-on is running without the local gate — recognition stays open continuously.");
      openWakeRecognizer();
    }
  }

  function closeWakeRecognizer() {
    try {
      V.wake?.stop();
    } catch {
      /* already stopped */
    }
    V.wake = null;
  }

  function openWakeRecognizer() {
    if (!V.wakeActive || V.wake) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    applyHints(rec);
    V.wake = rec;
    rec.addEventListener("result", (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        // FINAL results only: the wake check is a server round trip, and the
        // tolerance rules that decide whether a microphone opens in a room
        // with a patient in it belong beside their tests, not reimplemented
        // here.
        if (!ev.results[i].isFinal) continue;
        void checkWake(ev.results[i][0].transcript);
      }
    });
    // A continuous recogniser stops itself on silence. Under the gate that is
    // expected and correct — it is reopened the next time somebody speaks —
    // so it is NOT restarted here.
    rec.addEventListener("end", () => {
      if (V.wake === rec) V.wake = null;
    });
    rec.addEventListener("error", () => {
      if (V.wake === rec) V.wake = null;
    });
    try {
      rec.start();
    } catch {
      V.wake = null;
    }
  }

  async function checkWake(heard) {
    try {
      const res = await fetch("/api/speech/wake", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: heard,
      });
      if (!res.ok) return;
      const m = await res.json();
      if (!m.matched) return;
      stopWake();
      if (m.remainder) submitTranscript(m.remainder);
      else startListening();
    } catch {
      /* a failed check just means the wake word did not fire */
    }
  }

  function stopWake() {
    V.wakeActive = false;
    stopVad();
    closeWakeRecognizer();
  }

  function resumeWake() {
    if (V.cfg?.mode === "always-on") void startWake();
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
        V.spokenText = "";
        V.hasMore = false;
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
        V.pendingTool = e.toolName || "";
        V.pendingRisk = e.risk || "confirm";
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
        if (V.brief && V.hasMore) note('Say "tell me more" for the rest.');
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
    if (!V.cfg?.enabled) {
      mountDisabled();
      return;
    }
    V.brief = V.cfg.verbosity === "brief";
    mount();
    await loadHints();
    if (V.cfg.mode === "always-on") void startWake();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
