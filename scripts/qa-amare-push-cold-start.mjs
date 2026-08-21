/**
 * Cold-start push routing: one pending destination, consumed after
 * router mount + auth hydration. Does not change production push.
 * Run: npm run test:amare-push-cold-start
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { pushPathForCandidate } from "../netlify/functions/amare-notification-copy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(root, "amare-app/package.json"))("typescript");

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const configSrc = fs.readFileSync(path.join(root, "amare-app/src/config.ts"), "utf8");
const safeFn = configSrc.match(/export function safeAppReturnPath[\s\S]*?\n\}/);
if (!safeFn) throw new Error("safeAppReturnPath missing from config.ts");

const controllerSrc = fs.readFileSync(path.join(root, "amare-app/src/push/PushController.tsx"), "utf8");
const mainSrc = fs.readFileSync(path.join(root, "amare-app/src/main.tsx"), "utf8");
const arrivalSrc = fs.readFileSync(path.join(root, "amare-app/src/push/push-arrival.ts"), "utf8");

check(
  "PushController does not navigate from a notification action listener",
  !controllerSrc.includes("pushNotificationActionPerformed"),
);
check(
  "PushController consume waits for auth resolution",
  /authResolved:\s*!loading/.test(controllerSrc) && /routerReady:\s*true/.test(controllerSrc),
);
check("PushController banner click uses the same pending destination", /setPendingPushDestination\(pathFromNotificationData/.test(controllerSrc));
check("banner path comes from pathFromNotificationData", /pathFromNotificationData\(notification\.data/.test(controllerSrc));
check("main bootstraps arrival before render", /bootstrapPushArrival\(\);/.test(mainSrc));
check("PushController is gated by VITE_ENABLE_AMARE_PUSH", /isAmarePushClientEnabled/.test(controllerSrc));
check("Arrival bootstrap no-ops when Push is off", /isAmarePushClientEnabled/.test(arrivalSrc));
check("arrival listener stores a pending destination, it does not navigate", /rememberNotificationAction/.test(arrivalSrc) && !/navigate\(/.test(arrivalSrc));
check("Push off-gate lives in PushController", /if \(!isAmarePushClientEnabled\(\)\) return children/.test(controllerSrc));

function transpile(src, fileName, rewrite) {
  const prepared = rewrite(src);
  return ts.transpileModule(prepared, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amare-push-cold-"));
fs.writeFileSync(
  path.join(dir, "config.mjs"),
  ts.transpileModule(safeFn[0], {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "config.ts",
  }).outputText,
);
fs.writeFileSync(
  path.join(dir, "push-path.mjs"),
  transpile(fs.readFileSync(path.join(root, "amare-app/src/lib/push-path.ts"), "utf8"), "push-path.ts", (src) =>
    src.replace('from "../config"', 'from "./config.mjs"'),
  ),
);
fs.writeFileSync(
  path.join(dir, "pending-destination.mjs"),
  transpile(
    fs.readFileSync(path.join(root, "amare-app/src/push/pending-destination.ts"), "utf8"),
    "pending-destination.ts",
    (src) => src.replace('from "../config"', 'from "./config.mjs"'),
  ),
);

const pendingMod = await import(`${pathToFileURL(path.join(dir, "pending-destination.mjs")).href}?t=1`);
const pathMod = await import(`${pathToFileURL(path.join(dir, "push-path.mjs")).href}?t=1`);
const {
  setPendingPushDestination,
  peekPendingPushDestination,
  resetPendingPushDestinationForTests,
  takePendingPushNavigation,
  loginPathForSafeReturn,
} = pendingMod;
const { pathFromNotificationData, safeAppReturnPath } = {
  ...pathMod,
  safeAppReturnPath: (await import(`${pathToFileURL(path.join(dir, "config.mjs")).href}?t=1`)).safeAppReturnPath,
};

const UPCOMING = "/my-classes?section=upcoming&classId=16025";
const WAITLIST = "/my-classes?section=waitlist&classId=16025";

function remember(data) {
  return setPendingPushDestination(pathFromNotificationData(data));
}

function pump({ routerReady = true, authResolved = true, signedIn = true } = {}) {
  return takePendingPushNavigation({ routerReady, authResolved, signedIn });
}

function navLog() {
  const calls = [];
  return {
    calls,
    consume(opts) {
      const decision = takePendingPushNavigation(opts);
      if (decision.kind === "navigate") calls.push(decision.to);
      return decision;
    },
  };
}

resetPendingPushDestinationForTests();

// C1 signed-in cold launch
{
  const nav = navLog();
  remember({ path: UPCOMING });
  check("C1 pending retained before auth", peekPendingPushDestination() === UPCOMING);
  const waiting = nav.consume({ routerReady: true, authResolved: false, signedIn: false });
  check("C1 waits before hydration", waiting.kind === "wait" && peekPendingPushDestination() === UPCOMING);
  const once = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  const again = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C1 navigates upcoming exactly once", once.kind === "navigate" && once.to === UPCOMING && again.kind === "idle" && nav.calls.length === 1, JSON.stringify(nav.calls));
}

// C2 signed-out cold launch
{
  resetPendingPushDestinationForTests();
  const nav = navLog();
  remember({ path: UPCOMING });
  const toLogin = nav.consume({ routerReady: true, authResolved: true, signedIn: false });
  const expectedLogin = loginPathForSafeReturn(UPCOMING);
  check("C2 routes through login return", toLogin.kind === "navigate" && toLogin.to === expectedLogin, toLogin.to);
  const resumed = safeAppReturnPath(new URL(toLogin.to, "https://app.local").searchParams.get("return"));
  check("C2 after login resumes upcoming", resumed === UPCOMING);
  const again = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C2 does not re-navigate after login consume", again.kind === "idle" && nav.calls.length === 1);
}

// C3 normal cold launch
{
  resetPendingPushDestinationForTests();
  const nav = navLog();
  const decision = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C3 no push stays idle (Home)", decision.kind === "idle" && peekPendingPushDestination() == null && nav.calls.length === 0);
}

// C4 malicious / invalid data.path
{
  resetPendingPushDestinationForTests();
  const attacks = [
    "https://evil.example/phish",
    "//evil.example",
    "/login?return=https://evil.example",
    "/auth/callback?code=x",
    "javascript:alert(1)",
    "/my-classes?section=upcoming&classId=16025/../admin",
  ];
  let allSafe = true;
  for (const raw of attacks) {
    const got = remember({ path: raw });
    if (got !== "/" && got.startsWith("/my-classes") === false) allSafe = false;
    if (got.includes("evil") || got.includes("javascript:") || got.startsWith("//")) allSafe = false;
    const decision = pump({ signedIn: true });
    if (decision.kind === "navigate" && (decision.to.includes("evil") || !decision.to.startsWith("/"))) allSafe = false;
  }
  check("C4 malicious path never navigates arbitrary URLs", allSafe);
  resetPendingPushDestinationForTests();
  const fallback = remember({ path: "https://evil.example" });
  const nav = navLog();
  nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C4 https path falls back to Home", fallback === "/" && nav.calls[0] === "/");
}

// C5 waitlist_promoted → Upcoming
{
  const promoted = pushPathForCandidate("waitlist_promoted", { classId: 16025 });
  const joined = pushPathForCandidate("waitlist_joined", { classId: 16025 });
  check("C5 helper sends promoted to upcoming", promoted === UPCOMING);
  check("C5 helper keeps joined on waitlist", joined === WAITLIST);
  resetPendingPushDestinationForTests();
  const nav = navLog();
  remember({ path: promoted });
  const decision = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C5 consume lands on Upcoming not Waitlist", decision.to === UPCOMING && !String(decision.to).includes("section=waitlist"));
}

// C6 action before router mount
{
  resetPendingPushDestinationForTests();
  const nav = navLog();
  remember({ path: UPCOMING });
  const beforeRouter = nav.consume({ routerReady: false, authResolved: true, signedIn: true });
  check("C6 retained before router ready", beforeRouter.kind === "wait" && peekPendingPushDestination() === UPCOMING);
  const after = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C6 consumed after router ready", after.kind === "navigate" && after.to === UPCOMING && nav.calls.length === 1);
}

// C7 action before auth hydration
{
  resetPendingPushDestinationForTests();
  const nav = navLog();
  remember({ path: UPCOMING });
  const beforeAuth = nav.consume({ routerReady: true, authResolved: false, signedIn: false });
  check("C7 retained before auth hydration", beforeAuth.kind === "wait" && peekPendingPushDestination() === UPCOMING);
  const after = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C7 consumed after auth resolution", after.kind === "navigate" && after.to === UPCOMING && nav.calls.length === 1);
  const rerender = nav.consume({ routerReady: true, authResolved: true, signedIn: true });
  check("C7 later rerenders do not loop", rerender.kind === "idle");
}

fs.rmSync(dir, { recursive: true, force: true });

if (failed) {
  console.log(`\nRESULT: FAIL (${failed})`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
