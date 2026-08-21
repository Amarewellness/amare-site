/**
 * Capacitor OPTIONS for stripe-create-checkout-session must short-circuit
 * before withLambda with a null-body 204. Local only. Does not create a session.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import createSessionDefault, {
  lambdaHandler as createSessionLambda,
} from "../netlify/functions/stripe-create-checkout-session.mjs";
import { withLambdaMobileCors } from "../netlify/functions/amare-lambda-mobile-cors.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function optionsRequest(origin) {
  return new Request("https://www.amarewellness.com/api/stripe/checkout/create-session", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });
}

function corsOk(res, origin) {
  const acao = res.headers.get("Access-Control-Allow-Origin");
  const methods = String(res.headers.get("Access-Control-Allow-Methods") || "");
  const allowHeaders = String(res.headers.get("Access-Control-Allow-Headers") || "").toLowerCase();
  return (
    res.status === 204 &&
    (acao === origin || acao === "*") &&
    methods.includes("POST") &&
    methods.includes("OPTIONS") &&
    allowHeaders.includes("authorization") &&
    allowHeaders.includes("content-type")
  );
}

const src = await readFile(path.join(root, "netlify/functions/stripe-create-checkout-session.mjs"), "utf8");
check("create-session default-exports withLambdaMobileCors", src.includes("export default withLambdaMobileCors(lambdaHandler)"));
check("create-session does not default-export plain withLambda", !src.includes("export default withLambda(lambdaHandler)"));
check("create-session still keeps block_if_active_subscription 409", src.includes("subscription_already_active") && src.includes("block_if_active_subscription"));
check("create-session does not export named handler", !/export (?:async function handler|const handler)/.test(src));

let innerRan = 0;
const wrapped = withLambdaMobileCors(async () => {
  innerRan += 1;
  return { statusCode: 204, body: "" };
});
const fromWrapper = await wrapped(optionsRequest("https://localhost"), { requestId: "qa-checkout-options" });
check("OPTIONS wrapper 204 + Capacitor CORS", corsOk(fromWrapper, "https://localhost"));
check("OPTIONS does not execute business handler", innerRan === 0, `innerRan=${innerRan}`);
check("OPTIONS body is null (modern-runtime safe)", fromWrapper.body == null || (await fromWrapper.text()) === "");

const fromDefault = await createSessionDefault(optionsRequest("https://localhost"), {
  requestId: "qa-checkout-default",
});
check("default-export Capacitor OPTIONS 204 + CORS", corsOk(fromDefault, "https://localhost"));

const guestPreflight = await createSessionDefault(optionsRequest("https://localhost"), {
  requestId: "qa-checkout-guest",
});
check("guest Hosted Checkout preflight 204", corsOk(guestPreflight, "https://localhost"));

const signedInPreflight = await createSessionDefault(optionsRequest("https://localhost"), {
  requestId: "qa-checkout-monthly",
});
check("signed-in monthly Hosted Checkout preflight 204", corsOk(signedInPreflight, "https://localhost"));

const websiteOptions = await createSessionDefault(optionsRequest("https://www.amarewellness.com"), {
  requestId: "qa-checkout-web",
});
check(
  "website origin OPTIONS still 204",
  websiteOptions.status === 204 &&
    (websiteOptions.headers.get("Access-Control-Allow-Origin") === "*" ||
      websiteOptions.headers.get("Access-Control-Allow-Origin") === "https://www.amarewellness.com"),
);

const lambdaOptions = await createSessionLambda({
  httpMethod: "OPTIONS",
  headers: { origin: "https://localhost" },
});
check(
  "lambdaHandler OPTIONS remains 204 for inner CORS",
  lambdaOptions.statusCode === 204 &&
    lambdaOptions.headers["Access-Control-Allow-Origin"] === "https://localhost",
);

if (failed) {
  console.error(`\n${failed} checkout mobile CORS QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checkout mobile CORS QA checks passed.");
