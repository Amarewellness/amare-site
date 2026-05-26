/**
 * Loads key=value pairs from project root `.env` if present (no dependency).
 * Skips blanks and `#` comments. Existing process.env wins (don't override).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseLine(line) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq <= 0) return null;
  const key = t.slice(0, eq).trim();
  let val = t.slice(eq + 1).trim();
  const inlineComment = val.indexOf(" #");
  if (inlineComment > 0) val = val.slice(0, inlineComment).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

export function loadLocalEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const kv = parseLine(line);
    if (!kv) continue;
    const [k, v] = kv;
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadLocalEnv();
