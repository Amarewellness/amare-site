import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {{ mtime: number, mod: Record<string, unknown> } | null} */
let cache = null;

/**
 * Hot-reload friendly import for local dev. On Netlify's esbuild bundle,
 * `import.meta.url` is often undefined — use a plain static import instead
 * (see stripe-catalog-lib.mjs header comment).
 */
export async function loadGuestPassLib() {
  const onNetlify = Boolean((process.env.NETLIFY || "").trim());
  if (onNetlify || typeof import.meta?.url !== "string" || !import.meta.url) {
    return await import("./guest-pass-lib.mjs");
  }

  try {
    const url = new URL("./guest-pass-lib.mjs", import.meta.url);
    const filePath = fileURLToPath(url);
    if (!existsSync(filePath)) {
      return await import("./guest-pass-lib.mjs");
    }
    const mtime = statSync(filePath).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.mod;
    url.searchParams.set("v", String(mtime));
    const mod = await import(url.href);
    cache = { mtime, mod: /** @type {Record<string, unknown>} */ (mod) };
    return cache.mod;
  } catch {
    return await import("./guest-pass-lib.mjs");
  }
}
