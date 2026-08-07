import { z } from "zod";
import { defineTool } from "../tools/registry.js";
import { newId } from "../shared/ids.js";
import type { Config } from "../config/config.js";
import type { MemoryStore } from "../memory/store.js";
import { appendAudit } from "../audit/store.js";
import {
  ALL_PARTY_STATES,
  CONTESTED_STATES,
  callVerdict,
  recordingVerdict,
  renderConsent,
  type CallTarget,
} from "./consent.js";
import { checkDtmf, chooseOption, recordOutcome, renderMap, type IvrMap, type IvrOption } from "./ivr.js";
import { classifyCall, renderState, summarizeHold, type Segment } from "./call-state.js";
import { extractOutcome, renderOutcome } from "./extract.js";
import { SimulatorProvider, buildTwilioDial, describeTwilioRequest, type TelephonyProvider } from "./provider.js";

type Ctx = { services: Record<string, unknown> };

const store = (ctx: Ctx) => ctx.services.store as MemoryStore;
const config = (ctx: Ctx) => ctx.services.config as Config;

/**
 * One live provider per process.
 *
 * The simulator holds call state in memory, so a fresh instance per tool call
 * would lose the call between dialling it and listening to it.
 */
let provider: TelephonyProvider | null = null;
function telephony(): TelephonyProvider {
  if (!provider) provider = new SimulatorProvider();
  return provider;
}

/** Test seam — lets a scripted tree stand in for the default one. */
export function setTelephonyProvider(p: TelephonyProvider | null): void {
  provider = p;
}

function logEvent(ctx: Ctx, callId: string, atMs: number, kind: string, text: string): void {
  store(ctx)
    .db.prepare("INSERT INTO call_events (id, call_id, at_ms, kind, text, created_at) VALUES (?,?,?,?,?,?)")
    .run(newId("cev"), callId, atMs, kind, text.slice(0, 2000), Date.now());
}

function segmentsFor(ctx: Ctx, callId: string): Segment[] {
  return (
    store(ctx)
      .db.prepare("SELECT at_ms, text FROM call_events WHERE call_id = ? AND kind = 'heard' ORDER BY at_ms")
      .all(callId) as Array<{ at_ms: number; text: string }>
  ).map((r) => ({ atMs: r.at_ms, text: r.text }));
}

function transcriptFor(ctx: Ctx, callId: string): string {
  return (
    store(ctx)
      .db.prepare("SELECT kind, text FROM call_events WHERE call_id = ? AND kind IN ('heard','said') ORDER BY at_ms")
      .all(callId) as Array<{ kind: string; text: string }>
  )
    .map((r) => `${r.kind === "heard" ? "THEM" : "US"}: ${r.text}`)
    .join("\n");
}

export const callPolicyTool = defineTool({
  name: "call_policy_check",
  description:
    "Say whether a call may be placed and whether it may be recorded, before dialling anything. Recording consent follows the STRICTER of the two states on the call — twelve states make recording without every party's agreement a criminal offence, not a compliance lapse. Patient calls are refused outright: an AI voice is an 'artificial voice' under the TCPA per the FCC's February 2024 ruling.",
  schema: z.object({
    target: z.enum(["payer", "clearinghouse", "provider_office", "patient", "unknown"]).default("payer"),
    caller_state: z.string().default("").describe("Two-letter state the practice is calling from"),
    callee_state: z.string().default("").describe("Two-letter state being called"),
    record: z.boolean().default(false),
  }),
  execute: async (input, ctx) => {
    const cfg = config(ctx);
    const call = callVerdict(input.target as CallTarget);
    const recording = recordingVerdict(input.caller_state || cfg.voice.callerState, input.callee_state, input.record);
    return {
      content: [
        renderConsent(recording, call),
        "",
        `All-party consent states: ${ALL_PARTY_STATES.join(", ")}.`,
        `Treated as all-party because statute and case law disagree: ${CONTESTED_STATES.join(", ")}.`,
        "This table is a default, not legal advice. Statutes change — confirm with counsel before turning recording on anywhere.",
      ].join("\n"),
    };
  },
});

export const callStartTool = defineTool({
  name: "payer_call_start",
  description:
    "Place a call to a payer. Runs the consent and target checks first and refuses rather than dialling past them. Defaults to the local IVR simulator; real dialling requires voice.provider to be set to twilio, because a real payer call means saying a member ID out loud and this build is not approved for patient data.",
  schema: z.object({
    payer: z.string(),
    to_number: z.string().default("").describe("E.164, e.g. +18005551234. Ignored by the simulator."),
    callee_state: z.string().default(""),
    claim_ref: z.string().default("").describe("Which claim this call is about"),
    target: z.enum(["payer", "clearinghouse", "provider_office", "patient", "unknown"]).default("payer"),
    record: z.boolean().default(false),
  }),
  assessRisk: (input) => ({ level: "confirm" as const, reason: `place a phone call to ${input.payer}` }),
  execute: async (input, ctx) => {
    const cfg = config(ctx);
    const call = callVerdict(input.target as CallTarget);
    if (!call.allowed) return { content: call.reason, isError: true };

    const wantRecording = input.record || cfg.voice.recordCalls;
    const recording = recordingVerdict(cfg.voice.callerState, input.callee_state, wantRecording);
    if (wantRecording && !recording.allowed) {
      return { content: `Not dialling. ${recording.reason}`, isError: true };
    }

    if (cfg.voice.provider === "twilio") {
      const built = buildTwilioDial(
        {
          accountSid: process.env[cfg.voice.accountSidEnv] ?? "",
          authToken: process.env[cfg.voice.authTokenEnv] ?? "",
          webhookUrl: cfg.voice.webhookUrl,
        },
        {
          to: input.to_number,
          from: cfg.voice.fromNumber,
          callerState: cfg.voice.callerState,
          calleeState: input.callee_state,
          record: recording.allowed && wantRecording,
        },
      );
      if (typeof built === "string") return { content: built, isError: true };
      return {
        content: [
          "Twilio is configured but live dialling is not wired to the network in this build. The request that would be sent:",
          "",
          describeTwilioRequest(built),
          "",
          "Switch voice.provider to simulator to exercise the navigation, hold detection and outcome extraction end to end.",
        ].join("\n"),
        isError: true,
      };
    }

    const started = await telephony().dial({
      to: input.to_number,
      from: cfg.voice.fromNumber,
      callerState: cfg.voice.callerState,
      calleeState: input.callee_state,
      record: recording.allowed && wantRecording,
    });
    if (started.error) return { content: started.error, isError: true };

    const id = started.callId;
    store(ctx)
      .db.prepare(
        `INSERT INTO calls (id, provider, payer, target, to_number, caller_state, callee_state, recording,
           consent_note, claim_ref, state, started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        telephony().name,
        input.payer,
        input.target,
        input.to_number,
        cfg.voice.callerState,
        input.callee_state,
        recording.allowed && wantRecording ? 1 : 0,
        recording.reason,
        input.claim_ref,
        "dialing",
        Date.now(),
      );
    appendAudit(store(ctx), {
      kind: "call",
      actor: "payer_call_start",
      summary: `Dialled ${input.payer}${input.claim_ref ? ` about ${input.claim_ref}` : ""} via ${telephony().name}`,
      payload: { id, payer: input.payer, recording: recording.allowed && wantRecording },
    });

    return {
      content: [
        `Call ${id} to ${input.payer} (${telephony().name}).`,
        "",
        renderConsent(recording, call),
        "",
        "Say the identification line first, then poll with payer_call_listen.",
      ].join("\n"),
    };
  },
});

export const callListenTool = defineTool({
  name: "payer_call_listen",
  description:
    "Poll a call for what has been heard and say what state it is in: menu, hold, a person, or a mailbox. Hold is told from a person by REPETITION rather than by silence — a hold loop says the same sentence in the same words, and a person does not. Voicemail is checked before a person, because a recorded greeting sounds exactly like one and only one of them is safe to talk to.",
  schema: z.object({ call_id: z.string() }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT * FROM calls WHERE id = ?").get(input.call_id) as
      | { id: string; payer: string; started_at: number }
      | undefined;
    if (!row) return { content: `No call ${input.call_id}.`, isError: true };

    for (const segment of await telephony().listen(input.call_id)) {
      logEvent(ctx, input.call_id, segment.atMs, "heard", segment.text || (segment.music ? "[music]" : "[silence]"));
    }

    const segments = segmentsFor(ctx, input.call_id);
    const verdict = classifyCall(segments);
    const lastMs = segments.length ? segments[segments.length - 1].atMs : 0;
    const hold = summarizeHold(segments, lastMs);

    store(ctx).db.prepare("UPDATE calls SET state = ? WHERE id = ?").run(verdict.state, input.call_id);
    logEvent(ctx, input.call_id, lastMs, "state", verdict.state);

    const recent = segments.slice(-6).map((s) => `  [${Math.round(s.atMs / 1000)}s] ${s.text}`);
    return {
      content: [renderState(verdict, hold), "", "Heard:", ...recent].join("\n"),
    };
  },
});

export const callSayTool = defineTool({
  name: "payer_call_say",
  description:
    "Say something on the call. Ask for the call reference number before ending any call — it is the only part of the conversation that survives it, and without one an appeal resting on this call meets 'we have no record of it', which is unanswerable.",
  schema: z.object({ call_id: z.string(), text: z.string() }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT id FROM calls WHERE id = ?").get(input.call_id);
    if (!row) return { content: `No call ${input.call_id}.`, isError: true };
    await telephony().say(input.call_id, input.text);
    logEvent(ctx, input.call_id, Date.now(), "said", input.text);
    return { content: `Said: ${input.text}` };
  },
});

export const callPressTool = defineTool({
  name: "payer_call_press",
  description:
    "Press a menu key. Only single menu digits: a member ID, tax ID or date of birth is entered by the tool layer from the claim on the call, never typed from a chat turn — a value produced there could be plausible and belong to somebody else, and an IVR accepts it without comment.",
  schema: z.object({
    call_id: z.string(),
    digit: z.string().describe("One of 0-9, * or #"),
  }),
  execute: async (input, ctx) => {
    const verdict = checkDtmf("menu_digit", input.digit);
    if (!verdict.allowed) return { content: verdict.reason, isError: true };
    const row = store(ctx).db.prepare("SELECT id FROM calls WHERE id = ?").get(input.call_id);
    if (!row) return { content: `No call ${input.call_id}.`, isError: true };
    await telephony().press(input.call_id, input.digit);
    logEvent(ctx, input.call_id, Date.now(), "pressed", input.digit);
    return { content: `Pressed ${input.digit}.` };
  },
});

export const callNavigateTool = defineTool({
  name: "payer_call_navigate",
  description:
    "Choose a menu digit for what the tree just said, using the payer's learned map. Refuses to guess: a prompt that does not match, or two options that score within a hair of each other, returns no digit and advises an operator. A wrong digit does not fail — it succeeds into the wrong queue, waits, and reaches somebody who cannot help.",
  schema: z.object({
    payer: z.string(),
    level: z.string().default("main menu"),
    prompt: z.string().describe("What the menu said"),
    intent: z.string().default("").describe("What you are trying to reach, e.g. 'claim status'"),
    call_id: z.string().default("").describe("Press the digit on this call when one is chosen"),
  }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT * FROM ivr_maps WHERE payer = ? AND level = ?").get(input.payer, input.level) as
      | { options_json: string; last_confirmed_at: number; misses: number }
      | undefined;
    if (!row) {
      return {
        content: `No menu map for ${input.payer} / ${input.level}. Record one with ivr_map_set after listening to the tree once, or press 0 for an operator.`,
        isError: true,
      };
    }

    const map: IvrMap = {
      payer: input.payer,
      level: input.level,
      options: JSON.parse(row.options_json) as IvrOption[],
      lastConfirmedAt: row.last_confirmed_at,
      misses: row.misses,
    };
    const decision = chooseOption(input.prompt, map, input.intent);
    // A miss means the MENU stopped matching the map. A refusal because no intent
    // was given, or because the map does not cover the intent, says nothing about
    // the payer's tree and must not age the map toward stale.
    const updated = recordOutcome(map, decision.promptMatched, Date.now());
    store(ctx)
      .db.prepare("UPDATE ivr_maps SET last_confirmed_at = ?, misses = ?, updated_at = ? WHERE payer = ? AND level = ?")
      .run(updated.lastConfirmedAt, updated.misses, Date.now(), input.payer, input.level);

    if (!decision.choice) {
      return {
        content: [
          decision.advice,
          "",
          "Closest options:",
          ...decision.alternatives.map((a) => `  ${a.digit} — ${a.intent} (${(a.score * 100).toFixed(0)}%)`),
        ].join("\n"),
        isError: true,
      };
    }

    if (input.call_id) {
      await telephony().press(input.call_id, decision.choice.digit);
      logEvent(ctx, input.call_id, Date.now(), "pressed", decision.choice.digit);
    }
    return {
      content: `Press ${decision.choice.digit} — ${decision.choice.intent}. ${decision.choice.reason}${input.call_id ? " Pressed." : ""}`,
    };
  },
});

export const ivrMapSetTool = defineTool({
  name: "ivr_map_set",
  description:
    "Record a payer's phone menu so it can be navigated next time. Re-recording resets the staleness counter, which is how a tree that changed gets trusted again.",
  schema: z.object({
    payer: z.string(),
    level: z.string().default("main menu"),
    options: z
      .array(
        z.object({
          digit: z.string(),
          intent: z.string(),
          phrases: z.array(z.string()).min(1).describe("Words from the spoken menu that identify this option"),
        }),
      )
      .min(1),
  }),
  execute: async (input, ctx) => {
    const now = Date.now();
    store(ctx)
      .db.prepare(
        `INSERT INTO ivr_maps (payer, level, options_json, last_confirmed_at, misses, updated_at)
         VALUES (?,?,?,?,0,?)
         ON CONFLICT(payer, level) DO UPDATE SET
           options_json = excluded.options_json, last_confirmed_at = excluded.last_confirmed_at,
           misses = 0, updated_at = excluded.updated_at`,
      )
      .run(input.payer, input.level, JSON.stringify(input.options), now, now);
    return {
      content: renderMap({
        payer: input.payer,
        level: input.level,
        options: input.options,
        lastConfirmedAt: now,
        misses: 0,
      }),
    };
  },
});

export const ivrMapListTool = defineTool({
  name: "ivr_map_list",
  description: "Show the learned phone trees, and which have gone stale because a live prompt stopped matching.",
  schema: z.object({ payer: z.string().default("") }),
  execute: async (input, ctx) => {
    const rows = (
      input.payer
        ? store(ctx).db.prepare("SELECT * FROM ivr_maps WHERE payer = ?").all(input.payer)
        : store(ctx).db.prepare("SELECT * FROM ivr_maps").all()
    ) as Array<{ payer: string; level: string; options_json: string; last_confirmed_at: number; misses: number }>;
    if (rows.length === 0) return { content: "No menu maps recorded." };
    return {
      content: rows
        .map((r) =>
          renderMap({
            payer: r.payer,
            level: r.level,
            options: JSON.parse(r.options_json) as IvrOption[],
            lastConfirmedAt: r.last_confirmed_at,
            misses: r.misses,
          }),
        )
        .join("\n\n"),
    };
  },
});

export const callEndTool = defineTool({
  name: "payer_call_end",
  description:
    "Hang up and extract the outcome: reference number, who was spoken to, the claim's status, and what they committed to. Says loudly when no reference number was captured — that is the difference between a call that can be proved and one that cannot.",
  schema: z.object({ call_id: z.string() }),
  execute: async (input, ctx) => {
    const row = store(ctx).db.prepare("SELECT * FROM calls WHERE id = ?").get(input.call_id) as
      | { id: string; payer: string; claim_ref: string; started_at: number }
      | undefined;
    if (!row) return { content: `No call ${input.call_id}.`, isError: true };

    for (const segment of await telephony().listen(input.call_id)) {
      logEvent(ctx, input.call_id, segment.atMs, "heard", segment.text || "[silence]");
    }
    await telephony().hangUp(input.call_id);

    const transcript = transcriptFor(ctx, input.call_id);
    const outcome = extractOutcome(transcript);
    store(ctx)
      .db.prepare(
        "UPDATE calls SET state='ended', reference_number=?, representative=?, disposition=?, outcome_json=?, ended_at=? WHERE id=?",
      )
      .run(
        outcome.referenceNumber,
        outcome.representative,
        outcome.disposition,
        JSON.stringify(outcome),
        Date.now(),
        input.call_id,
      );

    if (outcome.referenceNumber && row.claim_ref) {
      const now = Date.now();
      store(ctx)
        .db.prepare(
          `INSERT INTO worklist_items (id, kind, title, detail_json, status, priority, created_at, updated_at)
           VALUES (?, 'denial', ?, ?, 'open', 0, ?, ?)`,
        )
        .run(
          newId("wl"),
          `Call ${outcome.referenceNumber} — ${row.payer} on ${row.claim_ref}`,
          JSON.stringify({ call: input.call_id, outcome }),
          now,
          now,
        );
    }

    appendAudit(store(ctx), {
      kind: "call",
      actor: "payer_call_end",
      summary: `Ended call to ${row.payer}: ${outcome.disposition}${outcome.referenceNumber ? `, ref ${outcome.referenceNumber}` : ", NO REFERENCE"}`,
      payload: { id: input.call_id, outcome },
    });

    return { content: renderOutcome(outcome) };
  },
});

export const callTranscriptTool = defineTool({
  name: "call_transcript",
  description: "The full transcript of a call, in order, with what was said on each side.",
  schema: z.object({ call_id: z.string() }),
  execute: async (input, ctx) => {
    const text = transcriptFor(ctx, input.call_id);
    return { content: text || `No transcript for ${input.call_id}.` };
  },
});

export const callHistoryTool = defineTool({
  name: "call_history",
  description:
    "Past calls with their reference numbers and outcomes. The calls without a reference are listed too — those are the ones that cannot be used to support anything.",
  schema: z.object({ claim_ref: z.string().default(""), limit: z.number().int().min(1).max(100).default(20) }),
  execute: async (input, ctx) => {
    const rows = (
      input.claim_ref
        ? store(ctx)
            .db.prepare("SELECT * FROM calls WHERE claim_ref = ? ORDER BY started_at DESC LIMIT ?")
            .all(input.claim_ref, input.limit)
        : store(ctx).db.prepare("SELECT * FROM calls ORDER BY started_at DESC LIMIT ?").all(input.limit)
    ) as Array<{
      id: string;
      payer: string;
      claim_ref: string;
      reference_number: string;
      representative: string;
      disposition: string;
      recording: number;
      started_at: number;
    }>;
    if (rows.length === 0) return { content: "No calls recorded." };

    const unprovable = rows.filter((r) => !r.reference_number).length;
    return {
      content: [
        ...rows.map(
          (r) =>
            `${new Date(r.started_at).toISOString().slice(0, 16).replace("T", " ")}  ${r.payer}${r.claim_ref ? ` / ${r.claim_ref}` : ""}  ` +
            `${r.disposition || "(no outcome)"}  ${r.reference_number ? `ref ${r.reference_number}` : "NO REFERENCE"}` +
            `${r.representative ? ` (${r.representative})` : ""}${r.recording ? " [recorded]" : ""}`,
        ),
        ...(unprovable > 0
          ? ["", `${unprovable} of these has no reference number and cannot be used to support an appeal.`]
          : []),
      ].join("\n"),
    };
  },
});
