/**
 * QA for post-verify booking confirmation recipient resolution.
 * Run: node scripts/qa-class-book-confirmation-recipient.mjs
 */
import fs from "node:fs/promises";
import {
  resolveBookingConfirmationRecipient,
  normalizeBookingConfirmationEmail,
} from "../netlify/functions/mindbody-class-book-lib.mjs";
import { displayEmailFromIdentities } from "../netlify/functions/amare-member-email-lib.mjs";

let failed = 0;

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = "") {
  if (!ok) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    if (detail) console.log(`  ${detail}`);
    return;
  }
  console.log(`PASS — ${name}`);
}

const bookSrc = await fs.readFile(
  new URL("../netlify/functions/mindbody-class-book.mjs", import.meta.url),
  "utf8",
);
const studioSrc = await fs.readFile(
  new URL("../netlify/functions/amare-studio-lib.mjs", import.meta.url),
  "utf8",
);

{
  let lookupCalled = false;
  const r = await resolveBookingConfirmationRecipient({
    clientId: 100002726,
    amareUserId: "usr_test",
    amareLinkedClientId: 100002726,
    amareSessionEmail: "snir5@pic-smart.com",
    consumerEmail: null,
    lookupMindbodyClientEmail: async () => {
      lookupCalled = true;
      return "should-not-be-used@example.com";
    },
  });
  check(
    "1. AMARÉ auth without mb_sess resolves session email (Resend path)",
    r.email === "snir5@pic-smart.com" && r.source === "amare_session" && !lookupCalled,
  );
}

{
  const r = await resolveBookingConfirmationRecipient({
    clientId: 100003671,
    amareLinkedClientId: null,
    amareSessionEmail: null,
    consumerEmail: "member@example.com",
  });
  check(
    "2. Consumer OAuth email resolves when session email absent",
    r.email === "member@example.com" && r.source === "consumer_oauth",
  );
}

{
  let lookupCalls = 0;
  const r = await resolveBookingConfirmationRecipient({
    clientId: 100002726,
    amareSessionEmail: null,
    consumerEmail: null,
    lookupMindbodyClientEmail: async (id) => {
      lookupCalls += 1;
      return id === 100002726 ? "snir5@pic-smart.com" : null;
    },
  });
  check(
    "3. Mindbody client lookup fallback when session/oauth missing",
    r.email === "snir5@pic-smart.com" && r.source === "mindbody_client" && lookupCalls === 1,
  );
}

{
  const r = await resolveBookingConfirmationRecipient({
    clientId: 100002726,
    amareUserId: "usr_test",
    amareLinkedClientId: 100009999,
    amareSessionEmail: "wrong@example.com",
    consumerEmail: null,
    lookupMindbodyClientEmail: async () => "snir5@pic-smart.com",
  });
  check(
    "4. AMARÉ clientId mismatch skips session email; Mindbody fallback only",
    r.email === "snir5@pic-smart.com" && r.source === "mindbody_client",
  );
}

{
  const r = await resolveBookingConfirmationRecipient({
    clientId: 100002726,
    amareSessionEmail: null,
    consumerEmail: null,
    lookupMindbodyClientEmail: async () => null,
  });
  check(
    "5. No email anywhere returns null (booking stays HTTP 200; mindbodyConfirmationEmail:false)",
    r.email == null && r.source == null,
  );
}

{
  const block = bookSrc.slice(
    bookSrc.indexOf("if (r.ok && !waitlist)"),
    bookSrc.indexOf("} else if (r.ok && waitlist)"),
  );
  const verifyFailIdx = block.indexOf("if (!verify.ok)");
  const resolverIdx = block.indexOf("resolveBookingConfirmationRecipient");
  check(
    "6. Verify failure skips recipient resolver and Resend",
    verifyFailIdx >= 0 && resolverIdx > verifyFailIdx,
  );
}

check(
  "7. Request body email cannot override server-resolved recipient",
  !bookSrc.includes("body.email") &&
    !bookSrc.includes("body.memberEmail") &&
    bookSrc.includes("resolveBookingConfirmationRecipient"),
);

check(
  "8. resolveStudioCustomer exposes AMARÉ session email fields",
  studioSrc.includes("resolveAmareSessionEmail") &&
    studioSrc.includes("amareSessionEmail") &&
    studioSrc.includes("consumerEmail"),
);

check(
  "9. displayEmailFromIdentities reads OTP identity email field",
  displayEmailFromIdentities([{ provider: "email", provider_sub: "snir5@pic-smart.com" }]) ===
    "snir5@pic-smart.com",
);

check(
  "10. normalizeBookingConfirmationEmail rejects invalid values",
  normalizeBookingConfirmationEmail("a@b.com") === "a@b.com" &&
    normalizeBookingConfirmationEmail("not-an-email") === null &&
    normalizeBookingConfirmationEmail("") === null,
);

if (failed) {
  console.log(`\n${failed} confirmation-recipient check(s) failed`);
  process.exit(1);
}
console.log("\nAll class-book confirmation-recipient QA checks passed.");
