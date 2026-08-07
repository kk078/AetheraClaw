import fs from "node:fs";
import path from "node:path";

// Resolve a model-supplied path and verify it cannot escape the workspace root —
// blocks ../ traversal, absolute paths outside the root, and symlink escapes.
// Model input is untrusted; every fs/shell path goes through here.
export function confinePath(workspaceRoot: string, requested: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const resolved = path.resolve(root, requested);

  // Find the nearest existing ancestor and realpath it (handles symlinks pointing out).
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== root && !realProbe.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  // Also verify the non-existing tail contains no traversal after resolution.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return resolved;
}
