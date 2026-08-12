import { newId } from "../shared/ids.js";

const CLARIFY_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (answer: string | null) => void;
  timer: NodeJS.Timeout;
}

// Registry of pending clarifying questions. The agent loop awaits request(); a
// client's clarify_response resolves it; an unanswered question times out to
// null — "no answer", not a guess — rather than the auto-deny false that fits
// ApprovalRegistry's yes/no shape but not this one.
export class ClarifyRegistry {
  private pending = new Map<string, Pending>();

  constructor(private timeoutMs: number = CLARIFY_TIMEOUT_MS) {}

  request(broadcast: (clarifyId: string) => void): { clarifyId: string; answer: Promise<string | null> } {
    const clarifyId = newId("clar");
    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(clarifyId);
        resolve(null);
      }, this.timeoutMs);
      this.pending.set(clarifyId, { resolve, timer });
    });
    broadcast(clarifyId);
    return { clarifyId, answer };
  }

  resolve(clarifyId: string, answerText: string): boolean {
    const entry = this.pending.get(clarifyId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(clarifyId);
    entry.resolve(answerText);
    return true;
  }
}
