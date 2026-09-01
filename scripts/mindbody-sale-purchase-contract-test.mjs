/**
 * Regression tests for PurchaseContract payload + Account Credit gate.
 * Run: node scripts/mindbody-sale-purchase-contract-test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  QA_ACCOUNT_CREDIT_CONTRACT_ID,
  QA_ACCOUNT_CREDIT_SERVICE_ID,
  PURCHASE_CONTRACT_FIRST_PAYMENT_OCCURS,
  buildPurchaseContractPayload,
  evaluateLiveAccountCreditGate,
  firstPaymentOccursIsDateString,
  isStrictYyyyMmDd,
  parseStartDateFromBody,
  parseUseAccountCreditFromBody,
  qaAccountCreditContract103EnvAllowed,
  resolvePurchaseContractSendNotifications,
} from "../netlify/functions/mindbody-sale-purchase-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function assertNoDateFirstPaymentOccurs(payload) {
  assert.equal(firstPaymentOccursIsDateString(payload.FirstPaymentOccurs), false);
  assert.equal(firstPaymentOccursIsDateString(payload.firstPaymentOccurs), false);
}

console.log("A. Existing card PurchaseContract (live) …");
{
  const payload = buildPurchaseContractPayload({
    clientId: 100002753,
    contractId: 101,
    test: false,
    lastFour: "4242",
    promotionCode: null,
    startDateYyyyMmDd: "2026-09-01",
    locationId: 1,
    useAccountCredit: false,
  });
  assert.ok(payload);
  assert.deepEqual(payload.StoredCardInfo, { LastFour: "4242" });
  assert.equal(payload.UseAccountCredit, undefined);
  assert.equal(payload.FirstPaymentOccurs, "Instant");
  assert.equal(payload.StartDate, "2026-09-01");
  assertNoDateFirstPaymentOccurs(payload);
  console.log("  PASS");
}

console.log("B. AccountCredit $0 contract payload …");
{
  const payload = buildPurchaseContractPayload({
    clientId: 100002753,
    contractId: QA_ACCOUNT_CREDIT_CONTRACT_ID,
    test: true,
    lastFour: null,
    promotionCode: null,
    startDateYyyyMmDd: "2026-09-01",
    locationId: 1,
    useAccountCredit: true,
    sendNotifications: false,
  });
  assert.ok(payload);
  assert.equal(payload.UseAccountCredit, true);
  assert.equal(payload.StoredCardInfo, undefined);
  assert.equal(payload.CreditCardInfo, undefined);
  assert.equal(payload.UseDirectDebit, undefined);
  assert.equal(payload.SendNotifications, false);
  assertNoDateFirstPaymentOccurs(payload);
  console.log("  PASS");
}

console.log("C. FirstPaymentOccurs never YYYY-MM-DD …");
{
  const cases = [
    buildPurchaseContractPayload({
      clientId: 1,
      contractId: 101,
      test: true,
      lastFour: null,
      promotionCode: null,
      startDateYyyyMmDd: "2026-12-25",
      locationId: 1,
      useAccountCredit: true,
    }),
    buildPurchaseContractPayload({
      clientId: 1,
      contractId: 101,
      test: false,
      lastFour: "9999",
      promotionCode: null,
      startDateYyyyMmDd: "2026-01-15",
      locationId: 1,
      useAccountCredit: false,
    }),
  ];
  for (const payload of cases) {
    assert.ok(payload);
    assert.equal(payload.FirstPaymentOccurs, PURCHASE_CONTRACT_FIRST_PAYMENT_OCCURS);
    assertNoDateFirstPaymentOccurs(payload);
    assert.equal(isStrictYyyyMmDd(String(payload.StartDate)), true);
  }
  console.log("  PASS");
}

console.log("D. Explicit StartDate preserved …");
{
  const parsed = parseStartDateFromBody({ startDate: "2027-03-15" }, "2026-09-01");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.date, "2027-03-15");
  const payload = buildPurchaseContractPayload({
    clientId: 1,
    contractId: 103,
    test: true,
    lastFour: null,
    promotionCode: null,
    startDateYyyyMmDd: parsed.date,
    locationId: 1,
    useAccountCredit: true,
  });
  assert.equal(payload?.StartDate, "2027-03-15");
  assert.equal(parseStartDateFromBody({}, "2026-09-01").date, "2026-09-01");
  assert.equal(parseStartDateFromBody({ startDate: "2026-13-40" }, "2026-09-01").ok, false);
  console.log("  PASS");
}

console.log("E. Promotion code + consent path unchanged (payload) …");
{
  const payload = buildPurchaseContractPayload({
    clientId: 1,
    contractId: 101,
    test: false,
    lastFour: "1234",
    promotionCode: "SPRING10",
    startDateYyyyMmDd: "2026-09-01",
    locationId: 1,
    useAccountCredit: false,
  });
  assert.equal(payload?.PromotionCode, "SPRING10");
  assert.equal(payload?.promotionCode, "SPRING10");
  const handlerSrc = readFileSync(
    join(root, "netlify/functions/mindbody-sale-purchase-contract.mjs"),
    "utf8",
  );
  assert.match(handlerSrc, /validateMembershipElectronicConsent\(/);
  assert.match(handlerSrc, /parsePromotionCodeFromBody\(/);
  console.log("  PASS");
}

console.log("F. Monthly Stripe flow unchanged …");
{
  const webhookSrc = readFileSync(join(root, "netlify/functions/stripe-webhook.mjs"), "utf8");
  assert.doesNotMatch(webhookSrc, /purchasecontract|purchase-contract|PurchaseContract/i);
  const purchaseSrc = readFileSync(
    join(root, "netlify/functions/mindbody-sale-purchase-contract.mjs"),
    "utf8",
  );
  assert.doesNotMatch(purchaseSrc, /monthly_5|invoice\.paid|stripe-webhook/);
  console.log("  PASS");
}

console.log("G. useAccountCredit explicit only …");
{
  assert.equal(parseUseAccountCreditFromBody({}), false);
  assert.equal(parseUseAccountCreditFromBody({ useAccountCredit: true }), true);
  assert.equal(parseUseAccountCreditFromBody({ UseAccountCredit: "true" }), true);
  assert.equal(parseUseAccountCreditFromBody({ useAccountCredit: false }), false);
  console.log("  PASS");
}

console.log("H. Live Account Credit QA gate …");
{
  const prev = process.env.MINDBODY_ALLOW_QA_CONTRACT_103_ACCOUNT_CREDIT;
  try {
    delete process.env.MINDBODY_ALLOW_QA_CONTRACT_103_ACCOUNT_CREDIT;
    assert.equal(qaAccountCreditContract103EnvAllowed(), false);
    assert.equal(
      evaluateLiveAccountCreditGate({
        contractId: QA_ACCOUNT_CREDIT_CONTRACT_ID,
        serviceId: QA_ACCOUNT_CREDIT_SERVICE_ID,
        useAccountCredit: true,
        test: false,
      }).ok,
      false,
    );
    assert.equal(
      evaluateLiveAccountCreditGate({
        contractId: QA_ACCOUNT_CREDIT_CONTRACT_ID,
        serviceId: QA_ACCOUNT_CREDIT_SERVICE_ID,
        useAccountCredit: true,
        test: true,
      }).ok,
      true,
    );
    process.env.MINDBODY_ALLOW_QA_CONTRACT_103_ACCOUNT_CREDIT = "1";
    assert.equal(qaAccountCreditContract103EnvAllowed(), true);
    assert.equal(
      evaluateLiveAccountCreditGate({
        contractId: QA_ACCOUNT_CREDIT_CONTRACT_ID,
        serviceId: QA_ACCOUNT_CREDIT_SERVICE_ID,
        useAccountCredit: true,
        test: false,
      }).ok,
      true,
    );
    assert.equal(
      evaluateLiveAccountCreditGate({
        contractId: 101,
        serviceId: 100133,
        useAccountCredit: true,
        test: false,
      }).ok,
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.MINDBODY_ALLOW_QA_CONTRACT_103_ACCOUNT_CREDIT;
    else process.env.MINDBODY_ALLOW_QA_CONTRACT_103_ACCOUNT_CREDIT = prev;
  }
  console.log("  PASS");
}

console.log("I. QA contract 103 suppresses notifications by default …");
{
  assert.equal(
    resolvePurchaseContractSendNotifications({
      useAccountCredit: true,
      contractId: QA_ACCOUNT_CREDIT_CONTRACT_ID,
      serviceId: QA_ACCOUNT_CREDIT_SERVICE_ID,
    }),
    false,
  );
  assert.equal(
    resolvePurchaseContractSendNotifications({
      useAccountCredit: false,
      contractId: 101,
      serviceId: 100129,
    }),
    true,
  );
  console.log("  PASS");
}

console.log("J. Live card without LastFour still fails payload build …");
{
  const payload = buildPurchaseContractPayload({
    clientId: 1,
    contractId: 101,
    test: false,
    lastFour: null,
    promotionCode: null,
    startDateYyyyMmDd: "2026-09-01",
    locationId: 1,
    useAccountCredit: false,
  });
  assert.equal(payload, null);
  console.log("  PASS");
}

console.log("K. Default sale location in payload …");
{
  const payload = buildPurchaseContractPayload({
    clientId: 1,
    contractId: 101,
    test: true,
    lastFour: null,
    promotionCode: null,
    startDateYyyyMmDd: "2026-09-01",
    locationId: 1,
    useAccountCredit: true,
  });
  assert.equal(payload?.LocationId, 1);
  console.log("  PASS");
}

console.log("\nAll mindbody-sale-purchase-contract tests passed.");
