/**
 * Version-controlled Annual pricing UI (build-time embed only).
 *
 * Source of truth: `src/content/annual-membership-ui.config.json`
 * (`annualMembershipUiEnabled`). No Netlify env var and no build override.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{ rootDir?: string }} [opts]
 * @returns {boolean}
 */
export function readAnnualMembershipUiEnabled(opts = {}) {
  const rootDir = opts.rootDir ?? defaultRoot;
  const fp = path.join(rootDir, "src/content/annual-membership-ui.config.json");
  if (!fs.existsSync(fp)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return parsed.annualMembershipUiEnabled === true;
  } catch {
    return false;
  }
}
