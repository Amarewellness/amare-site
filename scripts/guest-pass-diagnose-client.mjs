/**
 * Diagnose Bring-a-Friend eligibility + upcoming classes for a Mindbody client.
 * Usage: node scripts/guest-pass-diagnose-client.mjs --client-id=100002726
 */
import "./load-env.mjs";
import {
  buildUpcomingBookedClassesForMember,
  readGuestPassUsage,
  resolveGuestPassEntitlement,
  usageKey,
} from "../netlify/functions/guest-pass-lib.mjs";
import { loadGuestPassConfig } from "../netlify/functions/guest-pass-catalog-lib.mjs";
import { resolveGuestPassStaffHeaders } from "../netlify/functions/mindbody-guest-pass-sale.mjs";
import { getMindbodyStaffAccessTokenCached } from "../netlify/functions/mindbody-consumer-lib.mjs";
import { mindbodyStaffBearerHeaders } from "../netlify/functions/mindbody-upstream.mjs";
import { tryOpenGuestPassBlobStore, guestPassBlobsEnabled } from "../netlify/functions/guest-pass-blobs.mjs";

const clientId = parseInt(
  process.argv.find((a) => a.startsWith("--client-id="))?.split("=")[1] || "100002726",
  10,
);

/** @param {string} studioTimezone */
function serverNowStudioTz(studioTimezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: studioTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

async function staffHeaders() {
  const issued = await getMindbodyStaffAccessTokenCached({ issueTimeoutMs: 12000 });
  if (issued.ok) return mindbodyStaffBearerHeaders(issued.accessToken);
  return await resolveGuestPassStaffHeaders();
}

(async () => {
  console.log(`\nBring-a-Friend diagnose — clientId=${clientId}\n`);

  const sh = await staffHeaders();
  if (!sh) {
    console.error("No staff headers — set MINDBODY_STAFF_USERNAME/PASSWORD");
    process.exit(1);
  }

  const gp = loadGuestPassConfig();
  /** @type {Record<string, unknown>} */
  const debug = {
    resolvedClientId: clientId,
    resolvedEmail: null,
    serverNowStudioTz: serverNowStudioTz(gp.studioTimezone),
    siteId: (sh.SiteId || process.env.MINDBODY_SITE_ID || "").trim() || null,
    authMode: "staff",
  };

  const entitlement = await resolveGuestPassEntitlement(clientId, {}, {
    consumerAuthHeaders: sh,
    staffHeaders: sh,
    debug,
  });
  console.log("Entitlement:", JSON.stringify(entitlement, null, 2));

  const periodKey = entitlement.ok ? entitlement.periodKey : debug.periodKey;
  if (periodKey) {
    debug.periodKey = periodKey;
    debug.usageBlobKey = usageKey(clientId, String(periodKey));
  }

  let usageStatus = null;
  if (guestPassBlobsEnabled() && periodKey) {
    const store = tryOpenGuestPassBlobStore({});
    if (store) {
      const usage = await readGuestPassUsage(store, clientId, String(periodKey));
      usageStatus = usage ? String(usage.status || "") : null;
    }
  }
  debug.usageBlobStatus = usageStatus || null;

  if (!entitlement.ok) {
    debug.shortCircuitReason = "tier_not_eligible";
    console.log("\nDebug (compare to GET status?debug=1):\n", JSON.stringify(debug, null, 2));
    process.exit(0);
  }

  if (usageStatus === "failed_manual_review") debug.shortCircuitReason = "failed_manual_review";
  else if (usageStatus === "pending") debug.shortCircuitReason = "pending";
  else if (usageStatus === "confirmed") debug.shortCircuitReason = "confirmed";

  const dropdown = await buildUpcomingBookedClassesForMember({
    memberClientId: clientId,
    consumerAuthHeaders: sh,
    staffHeaders: sh,
    debug,
  });

  if (!debug.shortCircuitReason) {
    const upcomingBeforeCap = debug._upcomingVisitsBeforeCapacity;
    if (dropdown.length === 0) {
      debug.shortCircuitReason =
        typeof upcomingBeforeCap === "number" && upcomingBeforeCap > 0
          ? "no_capacity"
          : "no_upcoming_classes";
    } else {
      debug.shortCircuitReason = null;
    }
  }
  delete debug._upcomingVisitsBeforeCapacity;

  console.log(`\nEligible for guest dropdown (spots>=2): ${dropdown.length}`);
  for (const row of dropdown) {
    console.log(
      `  - classId=${row.classId} spots=${row.spotsRemaining} when=${row.startDateTime} name=${JSON.stringify(row.name)}`,
    );
  }

  console.log("\nDebug (compare to GET status?debug=1):\n", JSON.stringify(debug, null, 2));
  console.log("");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
