import type { Segment } from "./call-state.js";

// ── Where the audio comes from ───────────────────────────────────────────────
// A telephony provider behind an interface, with a local simulator as the
// default. That ordering is deliberate rather than a convenience for testing:
// everything worth getting right in this module — menu navigation, hold
// detection, whether a reference number was captured — is decided by what the
// transcriber produces, and none of it needs a real phone line to exercise.
//
// The simulator is also the only way to run this module honestly at all. A real
// payer call means saying a member ID out loud, and this deployment is not
// approved for real patient data.

export interface DialRequest {
  to: string;
  from: string;
  /** Where the practice is calling from, for the recording-consent rule. */
  callerState: string;
  calleeState: string;
  record: boolean;
}

export interface TelephonyProvider {
  readonly name: string;
  dial(request: DialRequest): Promise<{ callId: string; error?: string }>;
  /** Segments heard since the last poll. */
  listen(callId: string): Promise<Segment[]>;
  say(callId: string, text: string): Promise<void>;
  press(callId: string, digit: string): Promise<void>;
  hangUp(callId: string): Promise<void>;
}

// ── Local IVR simulator ──────────────────────────────────────────────────────

export interface SimulatedNode {
  /** What the tree says when this node is reached. */
  prompt: string;
  /** Digit → next node. */
  next: Record<string, string>;
  /** Seconds of hold music before the next thing is said. */
  holdSegments?: number;
  /** When set, reaching this node hands over to the scripted representative. */
  human?: string[];
  voicemail?: boolean;
}

export interface SimulatedTree {
  payer: string;
  start: string;
  nodes: Record<string, SimulatedNode>;
}

/**
 * A payer tree that behaves like the real thing, including the parts that make
 * it annoying: a menu that has to be listened to twice, a hold loop that repeats
 * the same reassurance, and a representative who does not volunteer a reference
 * number until asked.
 */
export const DEMO_TREE: SimulatedTree = {
  payer: "Demo Health Plan",
  start: "main",
  nodes: {
    main: {
      prompt:
        "Thank you for calling Demo Health Plan provider services. Please listen carefully as our menu options have changed. For eligibility and benefits, press 1. For claim status, press 2. For prior authorization, press 3. To speak with a representative, press 0.",
      next: { "1": "eligibility", "2": "claims", "3": "auth", "0": "queue" },
    },
    eligibility: {
      prompt: "You have reached eligibility and benefits. Please enter the member identification number followed by the pound key.",
      next: { "#": "queue" },
    },
    claims: {
      prompt:
        "You have reached claim status. For the status of a submitted claim, press 1. To check a claim payment, press 2. To return to the main menu, press 9.",
      next: { "1": "queue", "2": "queue", "9": "main" },
    },
    auth: {
      prompt: "You have reached prior authorization. All representatives are assisting other callers.",
      next: {},
      holdSegments: 2,
    },
    queue: {
      prompt: "Please hold for the next available representative.",
      next: {},
      holdSegments: 3,
      human: [
        "Thank you for holding, provider services, my name is Dana. Can I get your NPI and tax ID please?",
        "Thank you. And the claim number you are calling about?",
        "I see that claim. It was denied on 03/14/2026 for missing prior authorization. Denial code 197.",
        "I can send it back for reprocessing if you have the authorization number. I will note the account.",
        "Certainly. Your call reference number is REF-8842197. Is there anything else?",
      ],
    },
    voicemail: {
      prompt: "The party you have reached is not available. Please leave a message after the tone.",
      next: {},
      voicemail: true,
    },
  },
};

interface SimCall {
  node: string;
  step: number;
  humanIndex: number;
  clockMs: number;
  pending: Segment[];
  ended: boolean;
}

/**
 * The simulator.
 *
 * Deterministic: the same digits produce the same call every time, so a test can
 * assert on navigation rather than on luck.
 */
export class SimulatorProvider implements TelephonyProvider {
  readonly name = "simulator";
  private calls = new Map<string, SimCall>();
  private counter = 0;

  constructor(private tree: SimulatedTree = DEMO_TREE) {}

  async dial(_request: DialRequest): Promise<{ callId: string }> {
    const callId = `sim-${++this.counter}`;
    const call: SimCall = { node: this.tree.start, step: 0, humanIndex: 0, clockMs: 0, pending: [], ended: false };
    this.enter(call, this.tree.start);
    this.calls.set(callId, call);
    return { callId };
  }

  private enter(call: SimCall, nodeName: string): void {
    const node = this.tree.nodes[nodeName];
    if (!node) return;
    call.node = nodeName;
    call.clockMs += 2000;
    call.pending.push({ atMs: call.clockMs, text: node.prompt });

    for (let i = 0; i < (node.holdSegments ?? 0); i++) {
      call.clockMs += 30_000;
      call.pending.push({ atMs: call.clockMs, text: "", music: true });
      call.clockMs += 15_000;
      // The same sentence, in the same words, every time — which is exactly what
      // makes a hold loop recognisable.
      call.pending.push({ atMs: call.clockMs, text: "Your call is important to us. Please continue to hold." });
    }

    if (node.human && node.human.length > 0) {
      call.clockMs += 5000;
      call.pending.push({ atMs: call.clockMs, text: node.human[0] });
      call.humanIndex = 1;
    }
  }

  async listen(callId: string): Promise<Segment[]> {
    const call = this.calls.get(callId);
    if (!call) return [];
    const out = call.pending;
    call.pending = [];
    return out;
  }

  async say(callId: string, text: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    const node = this.tree.nodes[call.node];
    if (!node?.human) return;
    // A representative answers whatever is said with the next scripted line;
    // asking for a reference number is what gets one, as on a real call.
    const wantsReference = /reference|ref(?:erence)? number|call reference/i.test(text);
    const index = wantsReference ? node.human.length - 1 : call.humanIndex;
    if (index < node.human.length) {
      call.clockMs += 6000;
      call.pending.push({ atMs: call.clockMs, text: node.human[index] });
      call.humanIndex = Math.min(node.human.length, index + 1);
    }
  }

  async press(callId: string, digit: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    const node = this.tree.nodes[call.node];
    const target = node?.next[digit];
    if (!target) {
      call.clockMs += 2000;
      call.pending.push({ atMs: call.clockMs, text: "I'm sorry, that is not a valid selection." });
      call.clockMs += 1000;
      call.pending.push({ atMs: call.clockMs, text: node?.prompt ?? "" });
      return;
    }
    this.enter(call, target);
  }

  async hangUp(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call) call.ended = true;
  }
}

// ── Twilio ───────────────────────────────────────────────────────────────────

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Public URL Twilio fetches TwiML from. */
  webhookUrl: string;
}

export interface TwilioRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * Build the REST request that places a call.
 *
 * Separated from sending it so the request can be asserted on without a network
 * or an account. `Record` is passed through explicitly rather than defaulted:
 * Twilio's default is off, and a module that quietly turned it on would be
 * enabling a wiretap offence in twelve states.
 */
export function buildTwilioDial(config: TwilioConfig, request: DialRequest): TwilioRequest | string {
  if (!config.accountSid || !config.authToken) {
    return "Twilio credentials are not configured. Set the account SID and auth token in the environment, or use the simulator.";
  }
  if (!config.webhookUrl) {
    return "No webhook URL configured. Twilio fetches call instructions from a URL it can reach, so a publicly reachable endpoint is required.";
  }
  if (!/^\+[1-9]\d{6,14}$/.test(request.to)) {
    return `"${request.to}" is not an E.164 number. Use the full international form, e.g. +18005551234.`;
  }

  const params = new URLSearchParams({
    To: request.to,
    From: request.from,
    Url: config.webhookUrl,
    Record: request.record ? "true" : "false",
    MachineDetection: "DetectMessageEnd",
  });

  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`,
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  };
}

/** Never print an auth header, whatever else is being logged. */
export function describeTwilioRequest(request: TwilioRequest): string {
  const params = new URLSearchParams(request.body);
  return [
    `POST ${request.url}`,
    `  To=${params.get("To")}  From=${params.get("From")}`,
    `  Record=${params.get("Record")}  MachineDetection=${params.get("MachineDetection")}`,
    "  Authorization: [not shown]",
  ].join("\n");
}
