const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

// Render one server event to the terminal. Returns "approval" when the caller must
// collect a y/N answer, "turn_done" when the prompt should return, or null.
export function render(event: Record<string, unknown>): "approval" | "turn_done" | null {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(String(event.text));
      return null;
    case "thinking_delta":
      return null; // keep terminal clean; thinking visible in web UI
    case "tool_call":
      process.stdout.write(`\n${dim(`⚙ ${event.toolName}: ${JSON.stringify(event.input).slice(0, 120)}`)}\n`);
      return null;
    case "tool_result":
      process.stdout.write(
        dim(`  ↳ ${event.isError ? "error: " : ""}${String(event.summary).replace(/\n/g, " ").slice(0, 160)}`) + "\n",
      );
      return null;
    case "approval_request":
      process.stdout.write(
        `\n${yellow(`⚠ Agent requests: ${event.description}`)}\n${dim(JSON.stringify(event.input).slice(0, 300))}\n`,
      );
      return "approval";
    case "approval_resolved":
      process.stdout.write(dim(`  [${event.approved ? "approved" : "denied"}]`) + "\n");
      return null;
    case "turn_started":
      process.stdout.write("\n");
      return null;
    case "turn_completed":
      process.stdout.write("\n");
      return "turn_done";
    case "refusal":
      process.stdout.write(red("\n[the model declined this request]\n"));
      return null;
    case "error":
      process.stdout.write(red(`\n[error: ${event.message}]\n`));
      return String(event.message).includes("already running") ? null : null;
    default:
      return null;
  }
}
