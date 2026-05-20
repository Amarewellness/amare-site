/**
 * Quick pre-deploy checks for mindbody-webhooks-schedule handler.
 * Usage: node scripts/verify-webhook-schedule.mjs
 */
import { handler } from "../netlify/functions/mindbody-webhooks-schedule.mjs";

const saved = {
  MINDBODY_WEBHOOK_SIGNATURE_KEY: process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY,
  MINDBODY_WEBHOOK_SKIP_VERIFY: process.env.MINDBODY_WEBHOOK_SKIP_VERIFY,
  MINDBODY_SITE_ID: process.env.MINDBODY_SITE_ID,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** @param {string} name @param {import('../netlify/functions/mindbody-webhooks-schedule.mjs').handler extends Function ? never : any} event */
async function run(name, event) {
  const res = await handler(event);
  console.log(`${name}: ${res.statusCode}`, res.body ? JSON.parse(res.body) : "(empty)");
  return res.statusCode;
}

let failed = 0;

try {
  delete process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY;
  delete process.env.MINDBODY_WEBHOOK_SKIP_VERIFY;

  const headStatus = await run("HEAD (no signature key)", { httpMethod: "HEAD" });
  if (headStatus !== 200) {
    console.error("FAIL: HEAD expected 200");
    failed++;
  }

  const postStatus = await run("POST (no signature key)", {
    httpMethod: "POST",
    headers: { "X-Mindbody-Signature": "sha256=deadbeef" },
    body: "{}",
  });
  if (postStatus !== 503) {
    console.error("FAIL: POST without key expected 503");
    failed++;
  }

  process.env.MINDBODY_WEBHOOK_SIGNATURE_KEY = "test-secret-for-verify";
  const badSig = await run("POST (bad signature)", {
    httpMethod: "POST",
    headers: { "X-Mindbody-Signature": "sha256=deadbeef" },
    body: '{"eventId":"classSchedule.created","messageId":"m1"}',
  });
  if (badSig !== 401) {
    console.error("FAIL: POST with bad sig expected 401");
    failed++;
  }
} finally {
  restoreEnv();
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll webhook schedule checks passed.");
