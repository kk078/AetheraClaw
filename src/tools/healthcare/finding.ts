export interface ScrubFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
}

export function finding(
  severity: ScrubFinding["severity"],
  rule: string,
  message: string,
): ScrubFinding {
  return { severity, rule, message };
}
