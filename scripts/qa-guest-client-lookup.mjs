/**
 * Bring a Friend guest client lookup QA (findOrCreateGuestClient + related guards).
 * Local only. Mocked Mindbody for cases 1–8; live read-only probe optional for known duplicate email.
 *
 * Run: node scripts/qa-guest-client-lookup.mjs
 * Live duplicate probe: node scripts/qa-guest-client-lookup.mjs --live
 */
import "./load-env.mjs";

import {
  findOrCreateGuestClient,
  normalizeEmail,
  normalizePhone,
  __testing,
} from "../netlify/functions/mindbody-guest-client-lib.mjs";
import {
  findExistingGuestSlotConflict,
  emailReceivedKey,
  __testing as guestPassTesting,
} from "../netlify/functions/guest-pass-lib.mjs";
import { loadGuestPassConfig } from "../netlify/functions/guest-pass-catalog-lib.mjs";
import { resolveGuestPassStaffHeaders } from "../netlify/functions/mindbody-guest-pass-sale.mjs";

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const STAFF = { Authorization: "Bearer qa-staff" };

/** @param {Record<string, unknown[]>} searchMap */
function mockSearch(searchMap) {
  return async (_headers, searchText) => searchMap[String(searchText)] ?? [];
}

function clientRow(id, email, phone) {
  return {
    Id: id,
    Email: email,
    MobilePhone: phone,
  };
}

/** @param {{ ok?: boolean; status?: number; data?: unknown }} responses */
function mockFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return r;
  };
}

async function runMockedCases() {
  // 1. New guest — no email/phone match → created
  {
    const search = mockSearch({});
    const fetch = mockFetch([
      { ok: true, status: 200, data: { Client: { Id: 900001 } } },
    ]);
    const r = await findOrCreateGuestClient({
      firstName: "New",
      lastName: "Guest",
      emailLower: "new-guest-qa@example.com",
      phoneNorm: "17865550100",
      staffHeaders: STAFF,
      deps: { searchClients: search, fetchMb: fetch },
    });
    check("1 new guest → created", r.ok === true && r.matchedBy === "created" && r.guestClientId === 900001);
  }

  // 2. Existing guest — exact email match → reused by email
  {
    const search = mockSearch({
      "existing@example.com": [clientRow(1001, "existing@example.com", "17865550101")],
    });
    const r = await findOrCreateGuestClient({
      firstName: "Existing",
      lastName: "Guest",
      emailLower: "existing@example.com",
      phoneNorm: "17865550101",
      staffHeaders: STAFF,
      deps: { searchClients: search, fetchMb: async () => ({ ok: false, status: 500 }) },
    });
    check("2 existing email → reused", r.ok === true && r.matchedBy === "email" && r.guestClientId === 1001);
  }

  // 3. Wrong email, exact phone match → reused by phone
  {
    const search = mockSearch({
      "wrong@example.com": [],
      "17865550102": [clientRow(1002, "real@example.com", "17865550102")],
    });
    const r = await findOrCreateGuestClient({
      firstName: "Phone",
      lastName: "Guest",
      emailLower: "wrong@example.com",
      phoneNorm: "17865550102",
      staffHeaders: STAFF,
      deps: { searchClients: search, fetchMb: async () => ({ ok: false, status: 500 }) },
    });
    check("3 wrong email, phone match → reused by phone", r.ok === true && r.matchedBy === "phone" && r.guestClientId === 1002);
  }

  // 4. Multiple email matches → guest_lookup_ambiguous
  {
    const search = mockSearch({
      "dup@example.com": [
        clientRow(2001, "dup@example.com", "17865550201"),
        clientRow(2002, "dup@example.com", "17865550202"),
      ],
    });
    const r = await findOrCreateGuestClient({
      firstName: "Dup",
      lastName: "Email",
      emailLower: "dup@example.com",
      phoneNorm: "",
      staffHeaders: STAFF,
      deps: { searchClients: search, fetchMb: async () => ({ ok: false, status: 500 }) },
    });
    check(
      "4 multiple email → ambiguous",
      r.ok === false && r.reason === "guest_lookup_ambiguous" && r.matchedBy === "email",
    );
  }

  // 5. Multiple phone matches → guest_lookup_ambiguous
  {
    const search = mockSearch({
      "phone-dup@example.com": [],
      "17865550300": [
        clientRow(3001, "a@example.com", "17865550300"),
        clientRow(3002, "b@example.com", "17865550300"),
      ],
    });
    const r = await findOrCreateGuestClient({
      firstName: "Dup",
      lastName: "Phone",
      emailLower: "phone-dup@example.com",
      phoneNorm: "17865550300",
      staffHeaders: STAFF,
      deps: { searchClients: search, fetchMb: async () => ({ ok: false, status: 500 }) },
    });
    check(
      "5 multiple phone → ambiguous",
      r.ok === false && r.reason === "guest_lookup_ambiguous" && r.matchedBy === "phone",
    );
  }

  // 6. addclient duplicate error + email retry finds one → reused
  {
    const search = mockSearch({
      "retry-email@example.com": [],
    });
    const fetchCalls = [];
    const fetch = async (method, path, headers, body) => {
      fetchCalls.push({ method, path, body });
      if (fetchCalls.length <= 2) {
        return {
          ok: false,
          status: 400,
          data: { Error: { Message: "Client email already exists" } },
        };
      }
      return { ok: true, status: 200, data: { Client: { Id: 999 } } };
    };
    const searchWithRetry = async (headers, text) => {
      if (text === "retry-email@example.com" && fetchCalls.length >= 2) {
        return [clientRow(4001, "retry-email@example.com", "17865550401")];
      }
      return [];
    };
    const r = await findOrCreateGuestClient({
      firstName: "Retry",
      lastName: "Email",
      emailLower: "retry-email@example.com",
      phoneNorm: "17865550401",
      staffHeaders: STAFF,
      deps: { searchClients: searchWithRetry, fetchMb: fetch },
    });
    check("6 duplicate error + email retry → reused", r.ok === true && r.matchedBy === "email" && r.guestClientId === 4001);
  }

  // 7. addclient duplicate error + phone retry finds one → reused
  {
    const fetchCalls = [];
    const fetch = async () => {
      fetchCalls.push(1);
      return {
        ok: false,
        status: 400,
        data: { Error: { Message: "duplicate client record" } },
      };
    };
    const searchWithRetry = async (_headers, text) => {
      if (text === "retry-phone@example.com") return [];
      if (text === "17865550500" && fetchCalls.length >= 2) {
        return [clientRow(5001, "other@example.com", "17865550500")];
      }
      return [];
    };
    const r = await findOrCreateGuestClient({
      firstName: "Retry",
      lastName: "Phone",
      emailLower: "retry-phone@example.com",
      phoneNorm: "17865550500",
      staffHeaders: STAFF,
      deps: { searchClients: searchWithRetry, fetchMb: fetch },
    });
    check("7 duplicate error + phone retry → reused", r.ok === true && r.matchedBy === "phone" && r.guestClientId === 5001);
  }

  // 8. addclient 200 creates duplicate email → guest_lookup_ambiguous
  {
    let searchPass = 0;
    const searchAfterCreate = async (_headers, text) => {
      searchPass += 1;
      if (text === "post-dup@example.com" && searchPass >= 3) {
        return [
          clientRow(6001, "post-dup@example.com", "17865550601"),
          clientRow(6002, "post-dup@example.com", "17865550602"),
        ];
      }
      return [];
    };
    const fetch = mockFetch([{ ok: true, status: 200, data: { Client: { Id: 6002 } } }]);
    const r = await findOrCreateGuestClient({
      firstName: "Post",
      lastName: "Dup",
      emailLower: "post-dup@example.com",
      phoneNorm: "17865550602",
      staffHeaders: STAFF,
      deps: { searchClients: searchAfterCreate, fetchMb: fetch },
    });
    check(
      "8 post-create duplicate email → ambiguous",
      r.ok === false && r.reason === "guest_lookup_ambiguous" && r.matchedBy === "email",
    );
  }

  // Post-create: one email match but different client than created ID
  {
    let searchPass = 0;
    const searchAfterCreate = async (_headers, text) => {
      searchPass += 1;
      if (text === "conflict@example.com" && searchPass >= 2) {
        return [clientRow(7001, "conflict@example.com", "17865550701")];
      }
      return [];
    };
    const fetch = mockFetch([{ ok: true, status: 200, data: { Client: { Id: 7999 } } }]);
    const r = await findOrCreateGuestClient({
      firstName: "Conflict",
      lastName: "Email",
      emailLower: "conflict@example.com",
      phoneNorm: "",
      staffHeaders: STAFF,
      deps: { searchClients: searchAfterCreate, fetchMb: fetch },
    });
    check(
      "8b post-create email belongs to different client → ambiguous",
      r.ok === false && r.reason === "guest_lookup_ambiguous" && r.candidateClientIds?.includes(7001),
    );
  }

  // Post-create: phone conflict with different client
  {
    let searchPass = 0;
    const searchAfterCreate = async (_headers, text) => {
      searchPass += 1;
      if (text === "phone-conflict@example.com" && searchPass >= 3) {
        return [clientRow(8002, "phone-conflict@example.com", "17865550802")];
      }
      if (text === "17865550800" && searchPass >= 4) {
        return [clientRow(8001, "other@example.com", "17865550800")];
      }
      return [];
    };
    const fetch = mockFetch([{ ok: true, status: 200, data: { Client: { Id: 8002 } } }]);
    const r = await findOrCreateGuestClient({
      firstName: "Phone",
      lastName: "Conflict",
      emailLower: "phone-conflict@example.com",
      phoneNorm: "17865550800",
      staffHeaders: STAFF,
      deps: { searchClients: searchAfterCreate, fetchMb: fetch },
    });
    check(
      "8c post-create phone belongs to different client → ambiguous",
      r.ok === false && r.reason === "guest_lookup_ambiguous" && r.matchedBy === "phone",
    );
  }

  // 9. guest_already_booked_to_class — handler restores slot before sale/book
  {
    const bafSrc = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../netlify/functions/mindbody-member-bring-a-friend.mjs", import.meta.url), "utf8"),
    );
    check(
      "9 BAF restores slot on guest_already_booked_to_class",
      bafSrc.includes('reason: "guest_already_booked_to_class"') && bafSrc.includes("restore: true"),
    );
    check(
      "9 BAF sale/book only after successful guest lookup",
      bafSrc.indexOf("issueGuestPassCompSale") > bafSrc.indexOf("findOrCreateGuestClient"),
    );
    check(
      "9 BAF restores slot on guest_lookup_ambiguous (no pass consume)",
      bafSrc.includes('guestLookup.reason === "guest_lookup_ambiguous"') &&
        bafSrc.includes('restore: guestLookup.reason !== "mindbody_guest_create_failed"'),
    );
  }

  // 10. same guest already used this period
  {
    process.env.GUEST_PASS_BLOBS = "1";
    const backing = new Map([
      [emailReceivedKey("guest@example.com", "2026-08"), { status: "confirmed" }],
    ]);
    const store = {
      async get(key, opts) {
        if (opts?.type !== "json") return null;
        return backing.get(key) ?? null;
      },
    };
    const conflict = await findExistingGuestSlotConflict(store, {
      emailLower: "guest@example.com",
      phoneNorm: "",
      periodKey: "2026-08",
      memberClientId: 100002726,
    });
    check(
      "10 guest_already_used_this_period",
      conflict.conflict === true && conflict.reason === "guest_already_used_this_period",
    );
  }

  // 11. same guest new calendar month — no conflict when only prior month keyed
  {
    process.env.GUEST_PASS_BLOBS = "1";
    const backing = new Map([
      [emailReceivedKey("guest@example.com", "2026-08"), { status: "confirmed" }],
    ]);
    const store = {
      async get(key, opts) {
        if (opts?.type !== "json") return null;
        return backing.get(key) ?? null;
      },
    };
    const conflict = await findExistingGuestSlotConflict(store, {
      emailLower: "guest@example.com",
      phoneNorm: "",
      periodKey: "2026-09",
      memberClientId: 100002726,
    });
    check("11 new calendar month → no guest period conflict", conflict.conflict === false);
  }

  // 12. ineligible member remains blocked (entitlement unchanged)
  {
    const gp = loadGuestPassConfig();
    const row = {
      Name: "Single Drop-In",
      ProductId: 999999,
      Remaining: 1,
      ExpirationDate: "2026-12-31T00:00:00",
    };
    const match = guestPassTesting.firstMonthlyMembershipMatch([row], gp, Date.now());
    check("12 non-monthly row → no entitlement match", match == null);
  }
}

async function runLiveDuplicateProbe() {
  const sh = await resolveGuestPassStaffHeaders();
  if (!sh) {
    check("live probe — staff headers", false, "staff_not_configured");
    return;
  }
  const r = await findOrCreateGuestClient({
    firstName: "Snir",
    lastName: "Guest",
    emailLower: normalizeEmail("snir1212@pic-smart.com"),
    phoneNorm: normalizePhone("(786) 503-1648"),
    staffHeaders: sh,
  });
  check(
    "live snir1212@pic-smart.com duplicate → guest_lookup_ambiguous",
    r.ok === false && r.reason === "guest_lookup_ambiguous" && r.matchedBy === "email",
    JSON.stringify(r),
  );
}

await runMockedCases();

if (process.argv.includes("--live")) {
  console.log("\n--- Live Mindbody read-only probe ---");
  await runLiveDuplicateProbe();
}

console.log(failed ? `\n${failed} failed` : "\nAll guest client lookup QA checks passed.");
process.exit(failed ? 1 : 0);
