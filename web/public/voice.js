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
    spokenThisTurn: false,
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

  function submitTranscript(text) {
    setPhase("idle");
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
  async function speak(markdown) {
    if (!V.cfg?.speakReplies || !markdown.trim()) return;
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
    if (!text.trim()) return;

    if (V.cfg.runsInBrowser) {
      if (!window.speechSynthesis) return;
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "en-US";
      utter.addEventListener("end", () => {
        if (V.phase === "speaking") setPhase("idle");
        resumeWake();
      });
      setPhase("speaking", "speaking");
      window.speechSynthesis.speak(utter);
      return;
    }

    try {
      setPhase("speaking", "speaking");
      const res = await fetch("/api/speech/synthesize", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: text,
      });
      if (!res.ok) {
        setPhase("idle");
        return;
      }
      const buf = await res.blob();
      const audio = new Audio(URL.createObjectURL(buf));
      V.audio = audio;
      audio.addEventListener("ended", () => {
        V.audio = null;
        if (V.phase === "speaking") setPhase("idle");
        resumeWake();
      });
      await audio.play();
    } catch {
      setPhase("idle");
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
        V.spokenThisTurn = false;
        setPhase("thinking", "working");
        break;
      case "text_delta":
        V.reply += e.text;
        break;
      case "approval_request":
        // Spoken confirmation still shows the dialog — the buttons remain the
        // authority. Voice is a second way to answer it, never a replacement
        // for seeing what is about to run.
        V.awaitingApproval = e.approvalId;
        speak(`Approval needed. ${e.toolName}. ${e.description || ""} Say approve or deny.`);
        break;
      case "approval_resolved":
        V.awaitingApproval = null;
        break;
      case "turn_completed":
        if (!V.spokenThisTurn) {
          V.spokenThisTurn = true;
          speak(V.reply);
        }
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
    if (V.cfg.mode === "always-on") startWake();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
