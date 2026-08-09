// tsc emits .js only, so the schema has to be copied beside it. Done in Node
// rather than with `cp` because npm scripts run through cmd.exe on Windows,
// where `cp` does not exist and the build fails before it ever starts.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "dist", "memory");
mkdirSync(dest, { recursive: true });
copyFileSync(path.join(root, "src", "memory", "schema.sql"), path.join(dest, "schema.sql"));
