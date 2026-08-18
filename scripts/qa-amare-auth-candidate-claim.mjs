/**
 * Candidate claim UX + narrow anonymous-purchase auto-link.
 * Run: npm run test:amare-auth-candidate-claim
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAmareUserId } from "../netlify/functions/amare-identity-policy.mjs";
import {
  evaluateAnonymousPurchaseAutoLink,
  maskVerifiedEmailForClaimUi,
  sanitizeOrderIdHint,
} from "../netlify/functions/amare-auth-purchase-claim.mjs";
import { finishEmailAuthentication } from "../netlify/functions/amare-auth-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const loginJs = await readFile(path.join(root, "src/js/amare-auth.js"), "utf8");
const loginHtml = await readFile(path.join(root, "src/content/mindbody-login.html"), "utf8");
const verifySrc = await readFile(path.join(root, "netlify/functions/amare-auth-email-verify.mjs"), "utf8");
const authLib = await readFile(path.join(root, "netlify/functions/amare-auth-lib.mjs"), "utf8");
const purchaseLib = await readFile(path.join(root, "netlify/functions/amare-auth-purchase-claim.mjs"), "utf8");

check("candidate UI shows masked verified email", loginHtml.includes("amare-login-claim-email") && loginJs.includes("json.maskedEmail"));
check("candidate copy mentions purchases and credits", loginHtml.includes("existing purchases, credits, and bookings"));
check("technical booking-until-confirm copy removed", !loginHtml.includes("This does not change studio booking until you confirm"));
check("Continue as a new account removed from candidate", loginJs.includes("claimNewBtn.hidden = true") && loginJs.includes('mode === "pending_attach"'));
check("This isn't my profile never calls AddClient", loginJs.includes("claim_mismatch") && !/claimRejectBtn[\s\S]{0,400}profile\/create/.test(loginJs) && !/claim-reject[\s\S]{0,400}continueAsNew/.test(loginJs));
check("reject recovery offers different email and contact", loginHtml.includes("Use a different email") && loginHtml.includes("Contact AMARÉ"));
check("verify response uses server masked OTP email", verifySrc.includes("maskedEmail: result.maskedEmail") && authLib.includes("maskVerifiedEmailForClaimUi(email)"));
check("browser orderId is only a lookup hint", verifySrc.includes("orderIdHint: body.orderId") && purchaseLib.includes("never ownership"));
const claimConfirmSrc = await readFile(path.join(root, "netlify/functions/amare-auth-claim-confirm.mjs"), "utf8");
check(
  "signed-in candidate confirm does not require a leftover claim tx cookie",
  claimConfirmSrc.includes("claimTx && claimTx.amare_user_id") &&
    !claimConfirmSrc.includes("if (!claimTx || claimTx.amare_user_id"),
);
check("knownMindbodyClientId is not purchase proof", purchaseLib.includes("resolvedMindbodyClientId") && !/knownMindbodyClientId/.test(purchaseLib));

check("mask uses verified email only", maskVerifiedEmailForClaimUi("snir65@pic-smart.com") === "s••••@pic-smart.com");
check("mask rejects junk", maskVerifiedEmailForClaimUi("not-an-email") === null);
check("order id hint sanitizes spoofed values", sanitizeOrderIdHint("ord_M35X8BW257FH8VW9") && !sanitizeOrderIdHint("../etc/passwd") && !sanitizeOrderIdHint("100003708"));

const now = Date.now();
const userId = "usr_PURCHASEAUTO000000000001";
const goodOrder = {
  orderId: "ord_ABCDEFGHJKMNPQRSTVWXYZ2345",
  customerEmail: "buyer@example.com",
  resolvedMindbodyClientId: 100003708,
  mindbodySyncStatus: "mindbody_synced",
  commerceAuthSource: "SIGNED_OUT",
  fulfillmentSyncedAt: new Date(now - 60_000).toISOString(),
};

function baseEval(over = {}) {
  return evaluateAnonymousPurchaseAutoLink({
    verifiedEmail: "buyer@example.com",
    candidateClientId: 100003708,
    candidateCount: 1,
    currentAmareUserId: userId,
    existingOwnerUserId: null,
    dualSessionConflict: false,
    order: goodOrder,
    nowMs: now,
    ...over,
  });
}

check("trusted matching order can auto-link", baseEval().ok === true && baseEval().clientId === 100003708);
check("mismatched order clientId does not auto-link", baseEval({ order: { ...goodOrder, resolvedMindbodyClientId: 999 } }).ok === false);
check("different order email does not auto-link", baseEval({ order: { ...goodOrder, customerEmail: "other@example.com" } }).ok === false);
check("conflicting existing owner does not auto-link", baseEval({ existingOwnerUserId: "usr_OTHER000000000000000001" }).ok === false);
check("ambiguous Studio matches do not auto-link", baseEval({ candidateCount: 2 }).ok === false);
check("missing order does not auto-link", baseEval({ order: null }).ok === false);
check("dual-session conflict does not auto-link", baseEval({ dualSessionConflict: true }).ok === false);
check("different order.amareUserId blocks auto-link", baseEval({ order: { ...goodOrder, amareUserId: "usr_OTHER000000000000000001" } }).ok === false);
check("order.amareUserId equal to current user is allowed", baseEval({ order: { ...goodOrder, amareUserId: userId } }).ok === true);
check("Apple relay email never auto-links", baseEval({ verifiedEmail: "hidden@privaterelay.appleid.com", order: { ...goodOrder, customerEmail: "hidden@privaterelay.appleid.com" } }).ok === false);
check("unsynced order does not auto-link", baseEval({ order: { ...goodOrder, mindbodySyncStatus: "pending" } }).ok === false);
check("expired order does not auto-link", baseEval({ nowMs: now + 25 * 60 * 60 * 1000 }).ok === false);
check(
  "24h window prefers fulfillmentSyncedAt then updatedAt/createdAt",
  baseEval({
    order: {
      ...goodOrder,
      fulfillmentSyncedAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 30 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(now - 40 * 60 * 60 * 1000).toISOString(),
    },
  }).ok === true &&
    baseEval({
      order: {
        ...goodOrder,
        fulfillmentSyncedAt: undefined,
        updatedAt: new Date(now - 60_000).toISOString(),
        createdAt: new Date(now - 40 * 60 * 60 * 1000).toISOString(),
      },
    }).ok === true &&
    baseEval({
      order: {
        ...goodOrder,
        fulfillmentSyncedAt: undefined,
        updatedAt: undefined,
        createdAt: new Date(now - 60_000).toISOString(),
      },
    }).ok === true,
);

const googleFn = authLib.slice(
  authLib.indexOf("export async function finishGoogleAuthentication"),
  authLib.indexOf("export async function confirmAmareClaim"),
);
check(
  "Apple/Google do not use this OTP auto-link path",
  !googleFn.includes("evaluateAnonymousPurchaseAutoLink") &&
    !googleFn.includes("getOrder") &&
    !authLib.includes("finishAppleAuthentication"),
);

function memoryIdentity() {
  const users = new Map();
  const identities = [];
  const associations = [];
  let assocId = 1;
  return {
    users,
    identities,
    associations,
    async findIdentity(provider, sub) {
      return identities.find((i) => i.provider === provider && i.provider_sub === sub) || null;
    },
    async createUserWithIdentity({ provider, provider_sub, email, email_verified }) {
      const amare_user_id = newAmareUserId();
      users.set(amare_user_id, { amare_user_id });
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
      return { amare_user_id, provider, provider_sub };
    },
    async attachIdentity({ amare_user_id, provider, provider_sub, email, email_verified }) {
      identities.push({ amare_user_id, provider, provider_sub, email: email || null, email_verified: !!email_verified });
    },
    async findActiveAssociationByClientId(siteId, clientId) {
      return (
        associations.find(
          (a) => a.site_id === siteId && Number(a.client_id) === Number(clientId) && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getActiveAssociation(amareUserId, siteId) {
      return (
        associations.find(
          (a) => a.amare_user_id === amareUserId && a.site_id === siteId && (a.status === "verified" || a.status === "linked"),
        ) || null
      );
    },
    async getLatestAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId);
      return rows[rows.length - 1] || null;
    },
    async getCandidateAssociation(amareUserId, siteId) {
      const rows = associations.filter((a) => a.amare_user_id === amareUserId && a.site_id === siteId && a.status === "candidate");
      return rows[rows.length - 1] || null;
    },
    async proposeAssociation(input) {
      if (input.status === "verified" || input.status === "linked") throw new Error("propose_cannot_write_verified");
      associations.push({ id: assocId++, ...input, client_id: input.client_id ?? null });
    },
    async confirmAssociation(input) {
      if (input.explicitConfirm !== true) throw new Error("verified_requires_explicit_confirm");
      associations.push({
        id: assocId++,
        amare_user_id: input.amare_user_id,
        site_id: input.site_id,
        status: "verified",
        client_id: input.client_id,
        claim_method: input.claim_method,
        claim_proof_ref: input.claim_proof_ref || null,
      });
    },
    async promoteAssociationToLinked() {
      throw new Error("linked_forbidden_in_phase1");
    },
  };
}

const prev = { ...process.env };
process.env.ENABLE_AMARE_AUTH = "1";
process.env.ENABLE_AMARE_AUTH_EMAIL_OTP = "1";
process.env.ENABLE_AMARE_SESS_ISSUE = "1";
process.env.AMARE_SESSION_SECRET = "qa-candidate-amare-session-secret!!";
process.env.MINDBODY_SITE_ID = "amare-qa-candidate";
delete process.env.ENABLE_AMARE_MEMBER_READ;
delete process.env.ENABLE_AMARE_STUDIO_OPERATIONS;

const siteId = "amare-qa-candidate";
const normalMem = memoryIdentity();
const normal = await finishEmailAuthentication(
  { email: "unique@example.com", mbSessClientId: null, siteId },
  { identity: normalMem, searchStudioClientsByEmail: async () => [84521] },
);
check(
  "normal unique exact-email candidate still requires confirmation",
  normal.claim.status === "candidate" &&
    normal.claim.autoBind === false &&
    normal.purchaseConnected !== true &&
    Boolean(normal.claimTx) &&
    !normalMem.associations.some((a) => a.status === "verified" || a.status === "linked"),
);

const autoMem = memoryIdentity();
const auto = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: null, siteId },
  {
    identity: autoMem,
    searchStudioClientsByEmail: async () => [100003708],
    orderIdHint: goodOrder.orderId,
    getOrder: async (id) => (id === goodOrder.orderId ? goodOrder : null),
  },
);
check(
  "anonymous purchase with trusted matching order/client can auto-link",
  auto.claim.status === "verified" &&
    auto.purchaseConnected === true &&
    !auto.claimTx &&
    autoMem.associations.some((a) => a.status === "verified" && a.claim_proof_ref === `order:${goodOrder.orderId}`),
);
check("no duplicate amare_user created on auto-link", autoMem.users.size === 1 && autoMem.identities.length === 1);
check(
  "no duplicate Studio Client created on auto-link",
  !authLib.includes("createStudioClientForAmareOnboarding") ||
    !/evaluateAnonymousPurchaseAutoLink[\s\S]{0,800}createStudioClient/.test(authLib),
);

const spoofMem = memoryIdentity();
const spoof = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: null, siteId },
  {
    identity: spoofMem,
    searchStudioClientsByEmail: async () => [100003708],
    orderIdHint: "not-an-order",
    getOrder: async () => goodOrder,
  },
);
check(
  "browser-spoofed orderId/clientId cannot auto-link",
  spoof.claim.status === "candidate" && spoof.purchaseConnected !== true && Boolean(spoof.claimTx),
);

const mismatchMem = memoryIdentity();
const mismatch = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: null, siteId },
  {
    identity: mismatchMem,
    searchStudioClientsByEmail: async () => [100003708],
    orderIdHint: goodOrder.orderId,
    getOrder: async () => ({ ...goodOrder, resolvedMindbodyClientId: 1 }),
  },
);
check("mismatched trusted order stays candidate", mismatch.claim.status === "candidate" && mismatch.purchaseConnected !== true);

const ownerMem = memoryIdentity();
const usrOwner = newAmareUserId();
ownerMem.users.set(usrOwner, { amare_user_id: usrOwner });
ownerMem.associations.push({
  id: 1,
  amare_user_id: usrOwner,
  site_id: siteId,
  client_id: 100003708,
  status: "linked",
});
const owned = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: null, siteId },
  {
    identity: ownerMem,
    searchStudioClientsByEmail: async () => [100003708],
    orderIdHint: goodOrder.orderId,
    getOrder: async () => goodOrder,
  },
);
check("conflicting owner stays conflict and does not auto-link", owned.claim.status === "conflict" && owned.purchaseConnected !== true);

const ambMem = memoryIdentity();
const amb = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: null, siteId },
  {
    identity: ambMem,
    searchStudioClientsByEmail: async () => [100003708, 100003709],
    orderIdHint: goodOrder.orderId,
    getOrder: async () => goodOrder,
  },
);
check("ambiguous Studio matches do not auto-link", amb.claim.status === "ambiguous" && amb.purchaseConnected !== true);

const noHintMem = memoryIdentity();
const noHint = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: null, siteId },
  {
    identity: noHintMem,
    searchStudioClientsByEmail: async () => [100003708],
    getOrder: async () => goodOrder,
  },
);
check(
  "loss of order= falls back to normal candidate confirmation",
  noHint.claim.status === "candidate" && noHint.purchaseConnected !== true && Boolean(noHint.claimTx),
);

const zeroMem = memoryIdentity();
const zero = await finishEmailAuthentication(
  { email: "buyer@example.com", mbSessClientId: 100003708, siteId },
  {
    identity: zeroMem,
    searchStudioClientsByEmail: async () => [],
    orderIdHint: goodOrder.orderId,
    getOrder: async () => goodOrder,
  },
);
check(
  "Studio search must be exactly one match to auto-link",
  zero.claim.status === "candidate" && zero.purchaseConnected !== true,
);

for (const [k, v] of Object.entries(prev)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

if (failed) {
  console.error(`\n${failed} AMARÉ candidate-claim QA check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AMARÉ candidate-claim QA checks passed.");
