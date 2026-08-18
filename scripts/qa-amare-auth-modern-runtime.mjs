/**
 * Production-target web-auth Functions must ship on the modern Netlify runtime.
 * Does not infer from source syntax only: zip-it-and-ship-it reports runtimeAPIVersion.
 *
 * Run: node scripts/qa-amare-auth-modern-runtime.mjs
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_FORMAT, zipFunction } from "@netlify/zip-it-and-ship-it";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Enabled website auth endpoints that reach the identity DB. */
export const WEB_AUTH_DB_FUNCTIONS = [
  "amare-auth-email-request",
  "amare-auth-email-verify",
  "amare-auth-session",
  "amare-auth-claim-confirm",
  "amare-auth-profile-begin",
  "amare-auth-profile-create",
  "amare-auth-association-link",
  "amare-auth-member-access",
  "mindbody-oauth-callback",
  "mindbody-member-summary",
  "mindbody-class-book",
  "mindbody-class-cancel",
  "mindbody-class-waitlist-remove",
  "stripe-create-checkout-session",
  "amare-commerce-status",
];

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = await readFile(path.join(root, "package-lock.json"), "utf8");
const compatVersion = pkg.dependencies?.["@netlify/aws-lambda-compat"];
check(
  "@netlify/aws-lambda-compat is pinned exact 1.0.2",
  compatVersion === "1.0.2",
  `got ${compatVersion}`,
);
check(
  "lockfile has no + version for aws-lambda-compat",
  /"@netlify\/aws-lambda-compat": "1\.0\.2"/.test(lock) && !/"@netlify\/aws-lambda-compat": "[^"]*\+/.test(lock),
);

const dest = await mkdtemp(path.join(os.tmpdir(), "amare-modern-runtime-"));
try {
  for (const name of WEB_AUTH_DB_FUNCTIONS) {
    const src = await readFile(path.join(root, "netlify/functions", `${name}.mjs`), "utf8");
    check(
      `${name} keeps Lambda handler as lambdaHandler (named handler would force runtime v1)`,
      /export (?:async function lambdaHandler|const lambdaHandler)/.test(src) &&
        !/export (?:async function handler|const handler)/.test(src),
    );
    check(
      `${name} default-exports withLambda(lambdaHandler)`,
      src.includes("export default withLambda(lambdaHandler)"),
    );
    check(`${name} source is not a raw Request/Response rewrite`, !/export default async function\s*\(\s*request/.test(src));

    const result = await zipFunction(path.join(root, "netlify/functions", `${name}.mjs`), dest, {
      archiveFormat: ARCHIVE_FORMAT.NONE,
      basePath: root,
      repositoryRoot: root,
      config: {
        "*": {
          includedFiles: ["netlify/functions/_embedded/**/*.json"],
        },
      },
    });
    const version = result?.runtimeAPIVersion;
    check(
      `${name} bundled runtimeAPIVersion is modern (not 1)`,
      version != null && Number(version) !== 1,
      `got runtimeAPIVersion=${String(version)}`,
    );
  }
} finally {
  await rm(dest, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} AMARÉ modern-runtime QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ modern-runtime QA checks passed.");
