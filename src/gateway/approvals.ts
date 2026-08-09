import { newId } from "../shared/ids.js";

const APPROVAL_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

// Registry of pending approval requests. The agent loop awaits request(); a client's
// approval_response resolves it; unanswered requests auto-deny after a timeout.
export class ApprovalRegistry {
  private pending = new Map<string, Pending>();

  request(broadcast: (approvalId: string) => void): { approvalId: string; decision: Promise<boolean> } {
    const approvalId = newId("appr");
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(approvalId, { resolve, timer });
    });
    broadcast(approvalId);
    return { approvalId, decision };
  }

  resolve(approvalId: string, approved: boolean): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve(approved);
    return true;
  }
}
