import assert from "node:assert/strict";
import test from "node:test";
import {
  bookPayloadForPolicy,
  lateCancelConfirmCopy,
  parseCancellationPolicyRaw,
  requiresUnlimitedPolicyAcceptance,
  UNLIMITED_FEE_POLICY_VERSION,
} from "./cancellation-policy";

const unlimitedPolicy = parseCancellationPolicyRaw({
  kind: "unlimited_fee",
  requiresAcknowledgment: true,
  policyVersion: UNLIMITED_FEE_POLICY_VERSION,
});

const creditPolicy = parseCancellationPolicyRaw({
  kind: "credit_forfeit",
  requiresAcknowledgment: false,
});

test("requiresUnlimitedPolicyAcceptance matches unlimited_fee + requiresAcknowledgment", () => {
  assert.equal(requiresUnlimitedPolicyAcceptance(unlimitedPolicy), true);
  assert.equal(requiresUnlimitedPolicyAcceptance(creditPolicy), false);
  assert.equal(requiresUnlimitedPolicyAcceptance(null), false);
});

test("bookPayloadForPolicy only sends ack when checkbox was accepted", () => {
  assert.deepEqual(bookPayloadForPolicy(42, unlimitedPolicy, {}, false), { classId: 42 });
  assert.deepEqual(bookPayloadForPolicy(42, unlimitedPolicy, {}, true), {
    classId: 42,
    policyAcknowledged: true,
    policyVersion: UNLIMITED_FEE_POLICY_VERSION,
  });
});

test("lateCancelConfirmCopy uses fee wording for Unlimited members", () => {
  assert.match(lateCancelConfirmCopy(unlimitedPolicy), /\$10 fee/);
  assert.doesNotMatch(lateCancelConfirmCopy(unlimitedPolicy), /class credit/);
  assert.match(lateCancelConfirmCopy(creditPolicy), /class credit/);
});
