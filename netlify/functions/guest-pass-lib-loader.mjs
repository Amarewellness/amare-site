import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {{ mtime: number, mod: Record<string, unknown> } | null} */
let cache = null;

/** Hot-reload friendly import for local dev (static imports cache stale guest-pass-lib.mjs). */
export async function loadGuestPassLib() {
  const url = new URL("./guest-pass-lib.mjs", import.meta.url);
  const filePath = fileURLToPath(url);
  const mtime = statSync(filePath).mtimeMs;
  if (cache && cache.mtime === mtime) return cache.mod;
  url.searchParams.set("v", String(mtime));
  const mod = await import(url.href);
  cache = { mtime, mod: /** @type {Record<string, unknown>} */ (mod) };
  return cache.mod;
}
