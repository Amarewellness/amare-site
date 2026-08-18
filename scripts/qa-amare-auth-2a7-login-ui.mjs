/**
 * AMARÉ Auth 2A.7 Launch Login UI QA.
 * Run: npm run test:amare-auth-2a7
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleAmareAuthLogout } from "../netlify/functions/amare-auth-logout.mjs";
import { handleAmareAuthLogoutAll } from "../netlify/functions/amare-auth-logout-all.mjs";
import { AMARE_SESS_COOKIE } from "../netlify/functions/amare-sess-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const prevAuth = process.env.ENABLE_AMARE_AUTH;
const html = await readFile(path.join(root, "src/content/mindbody-login.html"), "utf8");
const js = await readFile(path.join(root, "src/js/amare-auth.js"), "utf8");
const css = await readFile(path.join(root, "src/css/components-amare-auth.css"), "utf8");
const plan = await readFile(path.join(root, "docs/AMARE-AUTH-PHASE2A-IMPLEMENTATION-PLAN.md"), "utf8");
const envExample = await readFile(path.join(root, ".env.example"), "utf8");
const toml = await readFile(path.join(root, "netlify.toml"), "utf8");
const build = await readFile(path.join(root, "scripts/build.mjs"), "utf8");
const header = await readFile(path.join(root, "src/js/header-members.js"), "utf8");
const classes = await readFile(path.join(root, "src/js/classes-schedule.js"), "utf8");
const member = await readFile(path.join(root, "src/js/member-dashboard.js"), "utf8");
const mbAuth = await readFile(path.join(root, "src/js/mindbody-auth.js"), "utf8");
const book = await readFile(path.join(root, "netlify/functions/mindbody-class-book.mjs"), "utf8");
const consumer = await readFile(path.join(root, "netlify/functions/mindbody-consumer-lib.mjs"), "utf8");
const oauthSession = await readFile(path.join(root, "netlify/functions/mindbody-oauth-session.mjs"), "utf8");
const oauthLogout = await readFile(path.join(root, "netlify/functions/mindbody-oauth-logout.mjs"), "utf8");
const sessionFn = await readFile(path.join(root, "netlify/functions/amare-auth-session.mjs"), "utf8");
const logoutAll = await readFile(path.join(root, "netlify/functions/amare-auth-logout-all.mjs"), "utf8");
const googleStart = await readFile(path.join(root, "netlify/functions/amare-auth-google-start.mjs"), "utf8");

check("plan documents proven amare_sess { amare_user_id, at, exp }", plan.includes("{ amare_user_id, at, exp }"));
check(
  "plan no longer treats session GET as claim-state enum",
  plan.includes("`GET /api/amare/auth/session` does **not** return this enum") &&
    !/API: `GET \/api\/amare\/auth\/session` returns this enum/.test(plan),
);
check("ENABLE_AMARE_AUTH_UI is documented and default-off", envExample.includes("# ENABLE_AMARE_AUTH_UI=0"));
check("build injects ENABLE_AMARE_AUTH_UI into login page", build.includes("__AMARE_AUTH_UI__") && build.includes("ENABLE_AMARE_AUTH_UI"));
check("login page is behind data-amare-auth-ui", html.includes('data-amare-auth-ui="__AMARE_AUTH_UI__"'));
check("Email OTP is the primary continue action", html.includes("AMARÉ LOGIN") && html.includes('id="amare-login-continue"') && html.includes("Continue"));
check("Mindbody is fallback copy, not a primary Continue button", html.includes("Already use Mindbody with AMARÉ?") && html.includes("Sign in with Mindbody") && !html.includes("Continue with Mindbody"));
check("Mindbody fallback uses existing OAuth start", html.includes("/api/mindbody/oauth/start") && js.includes("/api/mindbody/oauth/start"));
check("Google button is absent", !/Continue with Google|Sign in with Google/i.test(html + js));
check("Apple button is absent", !/Continue with Apple|Sign in with Apple/i.test(html + js));
check("Google implementation is retained", googleStart.includes("GET /api/amare/auth/google/start"));
check("no Apple start/callback files", !(await exists("netlify/functions/amare-auth-apple-start.mjs")) && !(await exists("netlify/functions/amare-auth-apple-callback.mjs")));

check("request-code endpoint used", js.includes("/api/amare/auth/email/request-code"));
check("verify-code endpoint used", js.includes("/api/amare/auth/email/verify-code"));
check("session GET used after verify", js.includes("/api/amare/auth/session") && js.includes("signedIn"));
check("session GET is not treated as claim authority", !js.includes("claimStatus") || js.includes("json.claimStatus"));
check("UI does not write auth authority to localStorage", !/localStorage\.(setItem|getItem)|sessionStorage\.(setItem|getItem)/.test(js));
check("email is trimmed in the UI only", js.includes(".trim()") && js.includes("maskEmail"));
check("OTP supports paste and numeric input", html.includes('inputmode="numeric"') && html.includes("one-time-code") && js.includes("paste"));
check("OTP has six positions and a Verify fallback", (html.match(/amare-login__otp-digit/g) || []).length === 6 && html.includes("Verify"));
check("resend is gated by a UI countdown", js.includes("RESEND_COOLDOWN_MS") && html.includes("Resend code"));
check("resend does not leak suppression", js.includes("If a new code can be sent"));
check("claim confirm requires explicitConfirm", js.includes("explicitConfirm: true") && js.includes("/api/amare/auth/claim/confirm"));
check("continue-as-new is only offered for pending_attach", js.includes("else if (mode === \"pending_attach\")") && js.includes("claimNewBtn.hidden = false") && js.includes("continueAsNew: true") && html.includes("This isn't my profile"));
check("claim UI does not send clientId as authority", !/claim\/confirm[\s\S]*clientId/.test(js) && !js.includes("client_id:"));
check("AMARÉ logout uses POST /api/amare/auth/logout", js.includes("/api/amare/auth/logout"));
check("full logout uses approved /logout/all", js.includes("/api/amare/auth/logout/all") && toml.includes("/api/amare/auth/logout/all"));
check("login CSS exists and is not hover-only", css.includes(".amare-login") && !/:hover[\s\S]*display:\s*none/.test(css));

check("header Members still uses Mindbody session", header.includes("/api/mindbody/oauth/session"));
check(
  "header AMARÉ session is general state only",
  !header.includes("/api/amare/auth/session") ||
    (header.includes("GENERAL AMARÉ signed-in state") && header.includes("never authorizes Book")),
);
check("Book dialog still says Sign in with Mindbody", classes.includes("Sign in with Mindbody") && !classes.includes("/api/amare/auth/session"));
check(
  "member dashboard does not use amare session as data authority",
  member.includes("/api/mindbody/member/summary") &&
    (!member.includes("/api/amare/auth/session") || member.includes("AMARÉ session is not member-data authority")),
);
check("mindbody-auth.js Book strings were not rewritten", mbAuth.includes("oauth/session") || mbAuth.includes("mb-auth"));
check(
  "logged-out Mindbody fallback is quiet text under Sign in",
  mbAuth.includes("mb-auth-bar__cta-wrap--stack") &&
    mbAuth.includes('class="mb-auth-bar__fresh link-quiet"') &&
    mbAuth.includes("Sign in with Mindbody"),
);
check(
  "AMARÉ signed-in bar can show display email",
  mbAuth.includes("function amareWhoHtml") && mbAuth.includes("mb-auth-bar__email") && mbAuth.includes("access.email"),
);
check("class-book does not read amare_sess", !book.includes("amare_sess"));
check("bookingAllowed / consumerAssociated unchanged", book.includes("bookingAllowed") && book.includes("consumerAssociated") && consumer.includes("resolveConsumerClient"));
check("Mindbody session contract unchanged", oauthSession.includes("bookingAllowed") || oauthSession.includes("booking_allowed"));
check("Mindbody logout still clears mb_sess only", oauthLogout.includes("mb_sess=") && !oauthLogout.includes("amare_sess"));
check("session function still omits claimStatus", !/JSON\.stringify\([\s\S]*claimStatus/.test(sessionFn) && sessionFn.includes("signedIn") && sessionFn.includes("amareUserId"));

delete process.env.ENABLE_AMARE_AUTH;
const disabledAll = await handleAmareAuthLogoutAll({ httpMethod: "POST", headers: {} });
check("logout/all disabled when master flag is off", disabledAll.statusCode === 404);

process.env.ENABLE_AMARE_AUTH = "1";
const foreign = await handleAmareAuthLogoutAll({
  httpMethod: "POST",
  headers: { host: "www.amarewellness.com", origin: "https://evil.example" },
});
check("logout/all rejects foreign Origin", foreign.statusCode === 403);

const all = await handleAmareAuthLogoutAll({
  httpMethod: "POST",
  headers: {
    cookie: `${AMARE_SESS_COOKIE}=keep; mb_sess=keep-me`,
    host: "www.amarewellness.com",
    origin: "https://www.amarewellness.com",
    "x-forwarded-proto": "https",
  },
});
const allCookies = [all.headers?.["Set-Cookie"], ...(all.multiValueHeaders?.["Set-Cookie"] || [])].flat().filter(Boolean).join("\n");
check("logout/all clears amare_sess", all.statusCode === 200 && /amare_sess=/.test(allCookies) && /Max-Age=0/.test(allCookies));
check("logout/all also clears mb_sess", /mb_sess=/.test(allCookies));

const amareOnly = await handleAmareAuthLogout({
  httpMethod: "POST",
  headers: {
    cookie: `${AMARE_SESS_COOKIE}=keep; mb_sess=keep-me`,
    host: "www.amarewellness.com",
    origin: "https://www.amarewellness.com",
  },
});
check("AMARÉ logout still does not clear mb_sess", !/mb_sess=/.test(String(amareOnly.headers?.["Set-Cookie"] || "")));
check("logout/all does not rewrite Mindbody logout function", logoutAll.includes("Does not change") && logoutAll.includes("mb_sess"));

const stripe = await readFile(path.join(root, "src/js/stripe-express-cta.js"), "utf8");
check("Stripe express CTA unchanged by login UI", !stripe.includes("/api/amare/auth/session"));

if (prevAuth === undefined) delete process.env.ENABLE_AMARE_AUTH;
else process.env.ENABLE_AMARE_AUTH = prevAuth;

if (failed) {
  console.error(`\n${failed} AMARÉ 2A.7 login UI QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ 2A.7 login UI QA checks passed.");

async function exists(rel) {
  try {
    await readFile(path.join(root, rel), "utf8");
    return true;
  } catch {
    return false;
  }
}
