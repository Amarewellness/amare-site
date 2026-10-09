/**
 * Cancel hook — error isolation + disabled default config (no Mindbody, no Postgres).
 * Run: node scripts/qa-attendance-fees-cancel-hook.mjs
 */
const CONFIG_OFF = { enabled: false, dryRun: true };

const { readFile } = await import("node:fs/promises");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel } = await import(
  "../netlify/functions/attendance-fee-cancel-hook.mjs"
);

const { resetAttendanceFeeStoreForTests, AttendanceFeeDbUnconfiguredError } = await import(
  "../netlify/functions/attendance-fee-store.mjs"
);

const CONFIG_LIVE = { enabled: true, dryRun: false };

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? ` (${detail})` : ""}`);
  }
}

{
  const r = await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel({
    visitId: 8001,
    classId: 500,
    clientId: 42,
    classStartMs: Date.now() + 3600000,
    classStartIso: new Date(Date.now() + 3600000).toISOString(),
    visitRow: { Id: 8001, ClientServiceId: 1, ClassId: 500 },
    authHeaders: {},
    authSource: "mindbody",
    loadClientServices: async () => [],
    config: CONFIG_OFF,
  });
  check("default source config (enabled=false) → disabled", r.outcome === "disabled");
}

const memoryStore = resetAttendanceFeeStoreForTests();

{
  const r = await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel({
    visitId: 8002,
    classId: 500,
    clientId: 42,
    classStartMs: Date.now() + 6 * 3600000,
    classStartIso: new Date(Date.now() + 6 * 3600000).toISOString(),
    visitRow: { Id: 8002, ClientServiceId: 1, ClassId: 500 },
    authHeaders: {},
    authSource: "mindbody",
    config: CONFIG_LIVE,
    store: memoryStore,
    forceMemory: true,
    loadClientServices: async () => [
      {
        Id: 1,
        ProductId: 100135,
        Name: "Unlimited",
        Remaining: 999999,
        ExpirationDate: "2027-01-01",
      },
    ],
  });
  check("injected live config + mock services → pending_created", r.outcome === "pending_created");
}

{
  const r = await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel({
    visitId: 8003,
    classId: 500,
    clientId: 42,
    classStartMs: Date.now() + 3600000,
    classStartIso: new Date(Date.now() + 3600000).toISOString(),
    visitRow: { Id: 8003, ClientServiceId: 1, ClassId: 500 },
    authHeaders: {},
    authSource: "mindbody",
    config: CONFIG_LIVE,
    store: resetAttendanceFeeStoreForTests(),
    forceMemory: true,
    loadClientServices: async () => {
      throw new Error("simulated_db_failure");
    },
  });
  check("store failure → error outcome not thrown", r.outcome === "error");
}

const cancelSrc = await readFile(path.join(root, "netlify/functions/mindbody-class-cancel.mjs"), "utf8");
const cancelCallIdx = cancelSrc.indexOf("await cancelMemberVisit({");
const recordIdx = cancelSrc.indexOf("await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel");
check(
  "wired after cancelMemberVisit success path",
  cancelCallIdx > 0 && recordIdx > cancelCallIdx && cancelSrc.includes("if (r.ok)"),
);
check(
  "uses tryRecord wrapper (error isolation)",
  cancelSrc.includes("await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel"),
);
check("no Stripe in cancel handler", !/stripe/i.test(cancelSrc));

{
  const savedUrl =
    (process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  delete process.env.NETLIFY_DB_URL;
  delete process.env.NETLIFY_DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const r = await tryRecordLateCancelAttendanceFeeAfterSuccessfulCancel({
      visitId: 8010,
      classId: 500,
      clientId: 42,
      classStartMs: Date.now() + 6 * 3600000,
      classStartIso: new Date(Date.now() + 6 * 3600000).toISOString(),
      visitRow: { Id: 8010, ClientServiceId: 1, ClassId: 500 },
      authHeaders: {},
      authSource: "mindbody",
      config: CONFIG_LIVE,
      loadClientServices: async () => [
        {
          Id: 1,
          ProductId: 100135,
          Name: "Unlimited",
          Remaining: 999999,
          ExpirationDate: "2027-01-01",
        },
      ],
    });
    check(
      "Postgres unavailable → error outcome, no memory fallback",
      r.outcome === "error" && !r.persisted,
    );
  } finally {
    if (savedUrl) process.env.NETLIFY_DB_URL = savedUrl;
  }
}

check(
  "AttendanceFeeDbUnconfiguredError exported",
  typeof AttendanceFeeDbUnconfiguredError === "function",
);

if (failed) process.exit(1);
console.log("\nAll cancel-hook checks passed.");
