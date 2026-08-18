/**
 * AMARÉ Auth 2A.7a entry-surface QA.
 * Run: npm run test:amare-auth-2a7a
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const build = await readFile(path.join(root, "scripts/build.mjs"), "utf8");
const header = await readFile(path.join(root, "src/js/header-members.js"), "utf8");
const classes = await readFile(path.join(root, "src/js/classes-schedule.js"), "utf8");
const pricing = await readFile(path.join(root, "src/js/pricing-api.js"), "utf8");
const stripe = await readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8");
const member = await readFile(path.join(root, "src/js/member-dashboard.js"), "utf8");
const memberHtml = await readFile(path.join(root, "src/content/mindbody-member.html"), "utf8");
const mbAuth = await readFile(path.join(root, "src/js/mindbody-auth.js"), "utf8");
const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const consumer = await readFile(path.join(root, "netlify/functions/mindbody-consumer-lib.mjs"), "utf8");

check("flag-off header still defaults to /member", build.includes("r(H.member)") && build.includes("amareAuthUiEnabled()"));
check("flag-on header uses /login with safe return", build.includes("H.login") && build.includes("safeHeaderReturnPath") && build.includes("?return="));
check("safe return rejects protocol-relative paths", build.includes('raw.startsWith("//")'));
check("header AMARÉ probe is flag-gated", header.includes("amareAuthUiEnabled()") && header.includes("/api/amare/auth/session"));
check("header still probes Mindbody session", header.includes("/api/mindbody/oauth/session"));
check("header does not store amareUserId", !/localStorage\.(setItem|getItem)\([^\)]*amareUserId/.test(header) && header.includes("AMARÉ signed-in state is not written to localStorage"));
check("header does not treat AMARÉ signed-in as Book/dashboard authority", header.includes("never authorizes Book") && header.includes("loginHref()"));
check("Book dialog still uses Mindbody", classes.includes("Sign in with Mindbody") && !classes.includes("/api/amare/auth/session"));
check("classes auth strip remains Mindbody for booking", mbAuth.includes("Sign in with Mindbody") && mbAuth.includes("/api/mindbody/oauth/start"));
check("pricing purchase sign-in remains Mindbody", pricing.includes("Sign in with Mindbody") && !pricing.includes("/api/amare/auth/session"));
check("Stripe express sign-in remains Mindbody", stripe.includes("Sign in with Mindbody") && !stripe.includes("/api/amare/auth/session"));
check("member dashboard still has Mindbody session path", member.includes("/api/mindbody/oauth/session") && member.includes("/api/mindbody/member/summary"));
check(
  "member dashboard loads summary only from mb_sess or linked access",
  member.includes("/api/amare/auth/member-access") &&
    member.includes("amareLinked") &&
    member.includes('studioAccess === "linked"'),
);
check("member page has an honest Mindbody gate", memberHtml.includes("data-mb-gate") && memberHtml.includes("data-mb-signin"));
check(
  "amare-only member copy does not say not signed in",
  member.includes("You’re signed in to AMARÉ") &&
    member.includes("linked studio profile or Mindbody") &&
    !/not signed in/i.test(member),
);
check("class-book does not read amare_sess", !book.includes("amare_sess"));
check("bookingAllowed / consumerAssociated unchanged", book.includes("bookingAllowed") && consumer.includes("resolveConsumerClient"));
check("no Google/Apple header buttons", !/Continue with Google|Continue with Apple/.test(header + build));

if (failed) {
  console.error(`\n${failed} AMARÉ 2A.7a entry QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.7a entry QA checks passed.");
