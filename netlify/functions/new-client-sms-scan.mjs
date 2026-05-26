/**
 * Daily New Client SMS conversion scan.
 *
 * Scheduled: ~10:00 AM US Eastern (14:00 UTC cron — see docs/NEW-CLIENT-SMS-FOLLOWUP.md).
 * Manual: POST /api/admin/new-client-sms/run with `x-admin-token`.
 *
 * Defaults: automation off, dry-run on, SMS sending off.
 */

import {
  getMindbodyStaffAccessTokenCached,
  jsonResponse,
} from "./mindbody-consumer-lib.mjs";
import { mindbodyStaffApiHeaders, mindbodyStaffBearerHeaders } from "./mindbody-upstream.mjs";
import {
  collectSeedClientIds,
  envTruthy,
  evaluateClientForSms,
  fetchClientServicesBatched,
  redactCandidateForReport,
  redactSkippedEvalForReport,
} from "./new-client-sms-lib.mjs";
import { adminAuthorized, adminCorsHeaders } from "./new-client-sms-admin-auth.mjs";
import {
  recommendedActionForCandidate,
  sendNewClientSmsAdminReport,
} from "./new-client-sms-admin-report.mjs";
import {
  persistSeedReportBlob,
  resolveSeedReportContent,
  seedUploadFilenameFromBody,
  shouldPersistSeedReportFromBody,
} from "./new-client-sms-seed-report.mjs";
import { openSmsFollowupStore } from "./new-client-sms-store.mjs";
import { sendTwilioSms, twilioSendAllowedByEnv } from "./twilio-sms-client.mjs";

/** 14:00 UTC ≈ 10:00 AM US Eastern (EDT). Adjust seasonally if needed. */
export const config = {
  schedule: "0 14 * * *",
};

/** @returns {Promise<Record<string, string> | null>} */
async function resolveStaffHeaders() {
  const issued = await getMindbodyStaffAccessTokenCached();
  if (issued.ok) return mindbodyStaffBearerHeaders(issued.accessToken);
  return mindbodyStaffApiHeaders();
}

/**
 * @param {unknown} event
 * @param {{ manual?: boolean }} [opts]
 */
export async function runNewClientSmsScan(event, opts) {
  const startedAt = Date.now();
  const dryRun = envTruthy("NEW_CLIENT_SMS_DRY_RUN");
  const automationEnabled = envTruthy("ENABLE_NEW_CLIENT_SMS_AUTOMATION");
  const sendGate = twilioSendAllowedByEnv();

  if (!automationEnabled) {
    const summary = {
      event: "new_client_sms_run_summary",
      ok: true,
      skippedRun: true,
      reason: "automation_disabled",
      dryRun,
      manual: Boolean(opts?.manual),
      durationMs: Date.now() - startedAt,
    };
    console.log(JSON.stringify(summary));
    return { statusCode: 200, body: summary };
  }

  const staffHeaders = await resolveStaffHeaders();
  if (!staffHeaders) {
    const summary = {
      event: "new_client_sms_run_summary",
      ok: false,
      error: "staff_headers_unavailable",
      dryRun,
      durationMs: Date.now() - startedAt,
    };
    console.log(JSON.stringify(summary));
    return { statusCode: 503, body: summary };
  }

  const smsStore = openSmsFollowupStore(event);

  /** @type {{ ok: boolean; key?: string; bytes?: number; error?: string } | null} */
  let seedReportPersist = null;
  if (opts?.manual && shouldPersistSeedReportFromBody(event)) {
    const resolved = await resolveSeedReportContent(event);
    if (resolved?.text) {
      try {
        seedReportPersist = await persistSeedReportBlob(event, resolved.text);
      } catch (err) {
        seedReportPersist = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const seed = await collectSeedClientIds(event, staffHeaders);
  const maxEvaluated = seed.caps.maxEvaluatedClients.configured;

  /** @type {ReturnType<typeof redactCandidateForReport>[]} */
  const candidates = [];
  /** @type {ReturnType<typeof redactSkippedEvalForReport>[]} */
  const skippedClients = [];
  /** @type {Record<string, number>} */
  const skippedByReason = {};
  let sent = 0;
  let sendFailed = 0;
  let skippedAlreadySent = 0;
  let evaluatedClients = 0;
  let truncatedEvaluation = 0;

  const evalQueue = [];
  for (const entry of seed.clientIds) {
    if (evalQueue.length >= maxEvaluated) {
      truncatedEvaluation += 1;
      continue;
    }
    evalQueue.push(entry);
  }

  const servicesBatch = await fetchClientServicesBatched(
    staffHeaders,
    evalQueue.map((e) => e.id),
  );

  for (const { id: clientId, seedSources, csvMeta } of evalQueue) {
    evaluatedClients += 1;

    const evalResult = await evaluateClientForSms(event, staffHeaders, clientId, seedSources, csvMeta, {
      preloadedServices: servicesBatch.byClientId.get(clientId) ?? [],
    });

    if (!evalResult.candidate) {
      const reason = evalResult.skipReasons[0] || "skipped";
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      skippedClients.push({
        ...redactSkippedEvalForReport(evalResult),
        action: "skipped_evaluation",
      });
      continue;
    }

    const ev = evalResult.candidate;
    const reportRow = redactCandidateForReport(ev);

    const existing = smsStore.available()
      ? await smsStore.get(ev.segment, ev.mindbodyClientId, ev.ncs.clientServiceId)
      : null;
    if (existing && existing.smsStatus === "sent") {
      skippedAlreadySent += 1;
      skippedByReason.skipped_already_sent = (skippedByReason.skipped_already_sent || 0) + 1;
      continue;
    }

    if (!ev.wouldSend) {
      candidates.push({ ...reportRow, action: "report_only", sendBlocked: ev.blockReason });
      console.log(
        JSON.stringify({
          event: "new_client_sms_candidate",
          ...reportRow,
          action: "report_only",
          sendBlocked: ev.blockReason,
        }),
      );
      continue;
    }

    if (dryRun || !sendGate.allowed) {
      candidates.push({
        ...reportRow,
        action: "dry_run_would_send",
        sendGate: sendGate.reasons,
      });
      console.log(
        JSON.stringify({
          event: "new_client_sms_candidate",
          ...reportRow,
          action: "dry_run_would_send",
        }),
      );
      continue;
    }

    if (!smsStore.available()) {
      candidates.push({ ...reportRow, action: "send_blocked", sendBlocked: "store_unavailable" });
      continue;
    }

    const now = new Date().toISOString();
    const pendingRecord = {
      segment: ev.segment,
      mindbodyClientId: ev.mindbodyClientId,
      ncsClientServiceId: ev.ncs.clientServiceId,
      phoneLast4: ev.phoneLast4,
      messagePreview: ev.messageBody.slice(0, 160),
      smsStatus: /** @type {const} */ ("pending"),
      twilioMessageSid: null,
      errorMessage: null,
      sendAttempts: 1,
      createdAt: now,
      sentAt: null,
      lastAttemptAt: now,
      dryRun: false,
    };

    const claim = await smsStore.putIfNew(pendingRecord);
    if (!claim.ok && claim.reason === "exists") {
      skippedAlreadySent += 1;
      skippedByReason.skipped_already_sent = (skippedByReason.skipped_already_sent || 0) + 1;
      continue;
    }
    if (!claim.ok) {
      sendFailed += 1;
      candidates.push({ ...reportRow, action: "send_blocked", sendBlocked: claim.reason || "claim_failed" });
      continue;
    }

    const sendRes = await sendTwilioSms(ev.phone, ev.messageBody);
    if (sendRes.ok) {
      sent += 1;
      await smsStore.patch(ev.segment, ev.mindbodyClientId, ev.ncs.clientServiceId, {
        smsStatus: "sent",
        twilioMessageSid: sendRes.messageSid,
        sentAt: new Date().toISOString(),
      });
      candidates.push({ ...reportRow, action: "sent", twilioMessageSid: sendRes.messageSid });
      console.log(
        JSON.stringify({
          event: "new_client_sms_sent",
          mindbodyClientId: ev.mindbodyClientId,
          segment: ev.segment,
          ncsClientServiceId: ev.ncs.clientServiceId,
          phoneLast4: ev.phoneLast4,
          twilioMessageSid: sendRes.messageSid,
        }),
      );
    } else {
      sendFailed += 1;
      await smsStore.patch(ev.segment, ev.mindbodyClientId, ev.ncs.clientServiceId, {
        smsStatus: "failed",
        errorMessage: sendRes.error,
      });
      candidates.push({ ...reportRow, action: "send_failed", error: sendRes.error });
      console.log(
        JSON.stringify({
          event: "new_client_sms_send_failed",
          mindbodyClientId: ev.mindbodyClientId,
          segment: ev.segment,
          error: sendRes.error,
        }),
      );
    }
  }

  const summary = {
    event: "new_client_sms_run_summary",
    ok: true,
    dryRun,
    sendGate,
    caps: seed.caps,
    seedSources: seed.seedSources,
    discoveryNotes: seed.discoveryNotes,
    discoveryApiCalls: seed.discoveryApiCalls,
    clientservicesBatchCalls: servicesBatch.apiCalls,
    clientservicesBatchSize: servicesBatch.batchSize,
    estimatedEvaluationApiCalls: evaluatedClients * 3 + servicesBatch.apiCalls,
    estimatedTotalApiCalls: seed.discoveryApiCalls + evaluatedClients * 3 + servicesBatch.apiCalls,
    seedClients: seed.clientIds.length,
    evaluatedClients,
    truncatedEvaluation,
    seedLookbackDays: seed.lookbackDays,
    orderStoreAvailable: seed.orderStoreAvailable,
    smsStoreMode: smsStore.mode(),
    candidates: candidates.length,
    skippedClients: skippedClients.length,
    sent,
    sendFailed,
    skippedAlreadySent,
    skippedByReason,
    seedReportLoaded: seed.seedReportLoaded,
    seedReportSource: seed.seedReportSource,
    seedReportFormat: seed.seedReportFormat,
    seedReportPersist,
    manual: Boolean(opts?.manual),
    durationMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(summary));

  const reportBody = {
    candidates,
    skippedClients,
    csvUnmatchedRows: seed.csvUnmatchedRows,
    csvAmbiguousRows: seed.csvAmbiguousRows,
  };

  /** @type {Awaited<ReturnType<typeof sendNewClientSmsAdminReport>>} */
  let adminEmail = { ok: false, skipped: true, reason: "not_attempted" };
  if (dryRun && summary.ok !== false) {
    adminEmail = await sendNewClientSmsAdminReport({ summary, report: reportBody });
  }

  return {
    statusCode: 200,
    body: {
      ...summary,
      adminEmail,
      report: reportBody,
    },
  };
}

/** @param {unknown} event */
function isScheduledInvocation(event) {
  if (!event || typeof event !== "object") return false;
  const e = /** @type {{ headers?: Record<string, string | undefined>; source?: string }} */ (event);
  if (e.source === "netlify-scheduled-function") return true;
  const headers = e.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-netlify-event" && String(v || "").toLowerCase() === "schedule") {
      return true;
    }
  }
  return false;
}

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return jsonResponse(204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    });
  }

  const scheduled = isScheduledInvocation(event);
  const isManualHttp = !scheduled && (method === "POST" || method === "GET");

  if (isManualHttp && !adminAuthorized(event)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  if (!scheduled && !isManualHttp) {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const result = await runNewClientSmsScan(event, { manual: isManualHttp });
  return jsonResponse(result.statusCode, result.body, adminCorsHeaders());
}
