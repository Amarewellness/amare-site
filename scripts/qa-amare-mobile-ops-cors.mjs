/**
 * Capacitor member/ops CORS on the modern Netlify default-export path.
 * Same proven OPTIONS-before-withLambda composition as AMARÉ auth.
 * Local only. Does not book, cancel, charge, or deploy.
 * Run: npm run test:amare-mobile-ops-cors
 */
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "./load-env.mjs";
import { withLambdaMobileCors } from "../netlify/functions/amare-lambda-mobile-cors.mjs";
import memberSummaryDefault, {
  lambdaHandler as memberSummaryLambda,
} from "../netlify/functions/mindbody-member-summary.mjs";
import classBookDefault, { lambdaHandler as classBookLambda } from "../netlify/functions/mindbody-class-book.mjs";
import classCancelDefault, {
  lambdaHandler as classCancelLambda,
} from "../netlify/functions/mindbody-class-cancel.mjs";
import waitlistRemoveDefault, {
  lambdaHandler as waitlistRemoveLambda,
} from "../netlify/functions/mindbody-class-waitlist-remove.mjs";
import { handler as bringFriendHandler } from "../netlify/functions/mindbody-member-bring-a-friend.mjs";
import { handler as bringFriendStatusHandler } from "../netlify/functions/mindbody-member-bring-a-friend-status.mjs";
import { issueAmareMobileTokenPair } from "../netlify/functions/mobile-auth-lib.mjs";

loadLocalEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "f315d80d-f61e-4fef-9a06-68bb09192d56";
const ACCOUNT = "68bd260c9ca87a8197818d4c";
const QA_USER = "usr_TRDWTEVFRGNME66PQ645RR";
const QA_CLIENT = 100002726;
const HYDRATE_KEYS = [
  "ENABLE_AMARE_AUTH",
  "ENABLE_AMARE_MEMBER_READ",
  "ENABLE_AMARE_STUDIO_OPERATIONS",
  "ENABLE_MOBILE_BEARER_AUTH",
  "MOBILE_JWT_SECRET",
  "AMARE_SESSION_SECRET",
  "MINDBODY_SESSION_SECRET",
  "MINDBODY_API_KEY",
  "MINDBODY_SITE_ID",
  "MINDBODY_STAFF_USERNAME",
  "MINDBODY_STAFF_PASSWORD",
  "MINDBODY_API_HOST",
];
let failed = 0;
/** @type {import("node:child_process").ChildProcess | null} */
let localDbKeeper = null;

function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function optionsRequest(url, method = "GET") {
  return new Request(url, {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });
}

function corsOk(res, allowMethodsNeed) {
  const acao = res.headers.get("Access-Control-Allow-Origin");
  const methods = String(res.headers.get("Access-Control-Allow-Methods") || "");
  const allowHeaders = String(res.headers.get("Access-Control-Allow-Headers") || "").toLowerCase();
  const vary = String(res.headers.get("Vary") || "");
  return (
    res.status === 204 &&
    acao === "https://localhost" &&
    allowMethodsNeed.every((m) => methods.split(",").map((s) => s.trim()).includes(m)) &&
    allowHeaders.includes("authorization") &&
    allowHeaders.includes("content-type") &&
    vary.toLowerCase().includes("origin")
  );
}

function lambdaCorsOk(res) {
  const headers = res?.headers || {};
  const acao = headers["Access-Control-Allow-Origin"] || headers["access-control-allow-origin"];
  const vary = String(headers.Vary || headers.vary || "");
  return res?.statusCode === 204 && acao === "https://localhost" && vary.toLowerCase().includes("origin");
}

function parseJson(raw) {
  const text = String(raw || "");
  const i = Math.min(...[text.indexOf("{"), text.indexOf("[")].filter((n) => n >= 0));
  if (!Number.isFinite(i) || i < 0) throw new Error("no_json");
  return JSON.parse(text.slice(i));
}

function productionValue(row) {
  const values = Array.isArray(row.values) ? row.values : [];
  const prod =
    values.find((v) => Array.isArray(v.context) && v.context.includes("production")) ||
    values.find((v) => v.context === "production") ||
    values.find((v) => v.context === "all") ||
    values.find((v) => Array.isArray(v.context) && v.context.includes("all"));
  return typeof prod?.value === "string" ? prod.value : "";
}

function hydrateSecretsFromNetlify() {
  const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");
  const api = spawnSync(
    process.execPath,
    [cli, "api", "getEnvVars", "--data", JSON.stringify({ account_id: ACCOUNT, site_id: SITE })],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (api.status !== 0) return false;
  const rows = parseJson(api.stdout);
  if (!Array.isArray(rows)) return false;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const key of HYDRATE_KEYS) {
    if ((process.env[key] || "").trim()) continue;
    const value = productionValue(byKey.get(key) || {});
    if (value) process.env[key] = value;
  }
  return HYDRATE_KEYS.filter((k) => k.startsWith("ENABLE_") || k === "MOBILE_JWT_SECRET" || k === "MINDBODY_API_KEY").every(
    (k) => Boolean((process.env[k] || "").trim()) || k === "MOBILE_JWT_SECRET",
  );
}

function isLocalDatabaseUrl(url) {
  return /localhost|127\.0\.0\.1|\.local(?:[:/]|$)/i.test(String(url || ""));
}

async function ensureLocalIdentityDb() {
  const existing = (
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ""
  ).trim();
  if (existing) {
    if (!isLocalDatabaseUrl(existing)) {
      delete process.env.NETLIFY_DATABASE_URL;
      delete process.env.DATABASE_URL;
      delete process.env.NETLIFY_DB_URL;
    } else {
      process.env.NETLIFY_DB_URL = existing;
      return true;
    }
  }
  const child = spawn(process.execPath, [path.join(root, "node_modules/netlify-cli/bin/run.js"), "database", "connect"], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  localDbKeeper = child;
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("local_netlify_db_connect_timeout")), 20000);
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/postgres:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(match[0].replace(/[.,;]+$/, ""));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`local_netlify_db_connect_exited:${code}`));
    });
  });
  if (!isLocalDatabaseUrl(url)) throw new Error("local_netlify_db_url_not_local");
  process.env.NETLIFY_DB_URL = url;
  return true;
}

function stopLocalDbKeeper() {
  if (!localDbKeeper || localDbKeeper.killed) return;
  try {
    localDbKeeper.stdin?.write("\\q\n");
  } catch {
    /* ignore */
  }
  localDbKeeper.kill();
  localDbKeeper = null;
}

async function assertOptions(name, handler, url, methods) {
  let innerRan = 0;
  const wrapped = withLambdaMobileCors(async () => {
    innerRan += 1;
    return { statusCode: 500, body: "should_not_run" };
  });
  const fromWrapper = await wrapped(optionsRequest(url, methods[0]), { requestId: "qa-ops-options" });
  check(`${name} OPTIONS wrapper 204 + CORS`, corsOk(fromWrapper, methods));
  check(`${name} OPTIONS does not execute business handler`, innerRan === 0, `innerRan=${innerRan}`);

  const fromDefault = await handler(optionsRequest(url, methods[0]), { requestId: "qa-ops-options" });
  check(`${name} default-export OPTIONS 204 + CORS`, corsOk(fromDefault, methods));
}

await assertOptions(
  "member/summary",
  memberSummaryDefault,
  "https://www.amarewellness.com/api/mindbody/member/summary",
  ["GET", "OPTIONS"],
);
await assertOptions(
  "class/book",
  classBookDefault,
  "https://www.amarewellness.com/api/mindbody/class/book",
  ["POST", "OPTIONS"],
);
await assertOptions(
  "class/cancel",
  classCancelDefault,
  "https://www.amarewellness.com/api/mindbody/class/cancel",
  ["GET", "POST", "OPTIONS"],
);
await assertOptions(
  "class/waitlist/remove",
  waitlistRemoveDefault,
  "https://www.amarewellness.com/api/mindbody/class/waitlist/remove",
  ["POST", "OPTIONS"],
);

const bafOptions = await bringFriendHandler({
  httpMethod: "OPTIONS",
  headers: { origin: "https://localhost" },
});
const bafStatusOptions = await bringFriendStatusHandler({
  httpMethod: "OPTIONS",
  headers: { origin: "https://localhost" },
});
check("bring-a-friend OPTIONS 204 + CORS (named handler)", lambdaCorsOk(bafOptions));
check("bring-a-friend/status OPTIONS 204 + CORS (named handler)", lambdaCorsOk(bafStatusOptions));

const lambdaOptions = await memberSummaryLambda({
  httpMethod: "OPTIONS",
  headers: { origin: "https://localhost" },
});
check("member/summary lambdaHandler OPTIONS still 204", lambdaCorsOk(lambdaOptions));

const ctx = { requestId: "qa-ops-auth" };
const dummyGet = await memberSummaryDefault(
  new Request("https://www.amarewellness.com/api/mindbody/member/summary", {
    method: "GET",
    headers: {
      Origin: "https://localhost",
      Authorization: "Bearer not-a-real-token",
      Accept: "application/json",
    },
  }),
  ctx,
);
check(
  "member/summary GET dummy bearer reaches withLambda (not OPTIONS 204)",
  dummyGet.status !== 204 && dummyGet.status !== 502,
  `status=${dummyGet.status}`,
);

const dummyBook = await classBookDefault(
  new Request("https://www.amarewellness.com/api/mindbody/class/book", {
    method: "POST",
    headers: {
      Origin: "https://localhost",
      Authorization: "Bearer not-a-real-token",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ classId: 1 }),
  }),
  ctx,
);
check(
  "class/book POST dummy bearer reaches auth path without booking",
  dummyBook.status === 401 || dummyBook.status === 403,
  `status=${dummyBook.status}`,
);

const dummyCancel = await classCancelDefault(
  new Request("https://www.amarewellness.com/api/mindbody/class/cancel?preflight=1&classId=1", {
    method: "GET",
    headers: {
      Origin: "https://localhost",
      Authorization: "Bearer not-a-real-token",
      Accept: "application/json",
    },
  }),
  ctx,
);
check(
  "class/cancel GET preflight dummy bearer reaches auth path",
  dummyCancel.status === 401 || dummyCancel.status === 403,
  `status=${dummyCancel.status}`,
);

const dummyWaitlist = await waitlistRemoveDefault(
  new Request("https://www.amarewellness.com/api/mindbody/class/waitlist/remove", {
    method: "POST",
    headers: {
      Origin: "https://localhost",
      Authorization: "Bearer not-a-real-token",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ waitlistEntryId: 1 }),
  }),
  ctx,
);
check(
  "class/waitlist/remove POST dummy bearer reaches auth path",
  dummyWaitlist.status === 401 || dummyWaitlist.status === 403,
  `status=${dummyWaitlist.status}`,
);

const dummyBookLambda = await classBookLambda({
  httpMethod: "POST",
  headers: { origin: "https://localhost", authorization: "Bearer not-a-real-token" },
  body: JSON.stringify({ classId: 1 }),
});
check(
  "class/book lambdaHandler dummy bearer is gated (no live book)",
  dummyBookLambda.statusCode === 401 || dummyBookLambda.statusCode === 403,
  `status=${dummyBookLambda.statusCode}`,
);

const dummyCancelLambda = await classCancelLambda({
  httpMethod: "GET",
  queryStringParameters: { preflight: "1", classId: "1" },
  headers: { origin: "https://localhost", authorization: "Bearer not-a-real-token" },
});
check(
  "class/cancel lambdaHandler dummy bearer is gated (no live cancel)",
  dummyCancelLambda.statusCode === 401 || dummyCancelLambda.statusCode === 403,
  `status=${dummyCancelLambda.statusCode}`,
);

const dummyWaitlistLambda = await waitlistRemoveLambda({
  httpMethod: "POST",
  headers: { origin: "https://localhost", authorization: "Bearer not-a-real-token" },
  body: JSON.stringify({ waitlistEntryId: 1 }),
});
check(
  "class/waitlist/remove lambdaHandler dummy bearer is gated (no live remove)",
  dummyWaitlistLambda.statusCode === 401 || dummyWaitlistLambda.statusCode === 403,
  `status=${dummyWaitlistLambda.statusCode}`,
);

process.env.ENABLE_AMARE_AUTH = process.env.ENABLE_AMARE_AUTH || "1";
process.env.ENABLE_AMARE_MEMBER_READ = process.env.ENABLE_AMARE_MEMBER_READ || "1";
process.env.ENABLE_MOBILE_BEARER_AUTH = process.env.ENABLE_MOBILE_BEARER_AUTH || "1";

const hydrated = hydrateSecretsFromNetlify();
check("hydrate member-read secrets without printing them", hydrated);
try {
  try {
    await ensureLocalIdentityDb();
  } catch (e) {
    check("local identity DB for member-read", false, String(e && e.message));
  }

  const pair = issueAmareMobileTokenPair(QA_USER);
  const liveGet = await memberSummaryDefault(
    new Request("https://www.amarewellness.com/api/mindbody/member/summary", {
      method: "GET",
      headers: {
        Origin: "https://localhost",
        Authorization: `Bearer ${pair.accessToken}`,
        Accept: "application/json",
      },
    }),
    { requestId: "qa-ops-member-read" },
  );
  let liveBody = {};
  try {
    liveBody = JSON.parse(await liveGet.text());
  } catch {
    liveBody = {};
  }
  const liveClient = Number(liveBody.clientId);
  check(
    "member/summary GET AMARÉ bearer → 200",
    liveGet.status === 200 && liveBody.ok === true && liveClient === QA_CLIENT,
    `status=${liveGet.status} clientId=${liveBody.clientId ?? "missing"} error=${liveBody.error || ""}`,
  );
} finally {
  stopLocalDbKeeper();
}

const wrapperSrc = await readFile(path.join(root, "netlify/functions/amare-lambda-mobile-cors.mjs"), "utf8");
check(
  "withLambdaMobileCors still calls withLambda for non-OPTIONS",
  wrapperSrc.includes("withLambda(lambdaHandler)"),
);

if (failed) {
  console.error(`\n${failed} mobile ops CORS QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll mobile ops CORS QA checks passed.");
