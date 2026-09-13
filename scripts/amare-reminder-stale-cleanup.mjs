/**
 * One-time stale class reminder cleanup — DRY RUN by default.
 *
 * Usage:
 *   node scripts/amare-reminder-stale-cleanup.mjs           # dry run (default)
 *   node scripts/amare-reminder-stale-cleanup.mjs --execute # mutates DB (requires separate authorization)
 *
 * Does NOT run automatically. Production cleanup is deferred until post-deploy verification.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "@netlify/database";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");
const cli = path.join(root, "node_modules/netlify-cli/bin/run.js");

function getProductionUrl() {
  const raw = spawnSync(
    process.execPath,
    [cli, "database", "status", "--branch", "production", "--show-credentials", "--json"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  ).stdout;
  const j = JSON.parse(raw.slice(raw.indexOf("{")));
  const url = String(j.database?.connectionString || "").trim();
  if (!url.startsWith("postgres")) {
    console.error("FAIL: could not resolve production database connection");
    process.exit(1);
  }
  return url;
}

async function main() {
  const db = getDatabase({ connectionString: getProductionUrl() });
  const now = new Date().toISOString();

  const countResult = await db.pool.query(
    `SELECT count(*)::int AS affected
       FROM amare_class_reminders
      WHERE status IN ('scheduled', 'due')
        AND sent_at IS NULL
        AND class_start_at IS NOT NULL
        AND class_start_at <= $1::timestamptz`,
    [now],
  );
  const affected = countResult.rows[0]?.affected ?? 0;

  const safetyResult = await db.pool.query(
    `SELECT count(*)::int AS future_actionable
       FROM amare_class_reminders
      WHERE status IN ('scheduled', 'due')
        AND sent_at IS NULL
        AND class_start_at > $1::timestamptz
        AND class_start_at <= $1::timestamptz + INTERVAL '36 hours'`,
    [now],
  );
  const futureActionable = safetyResult.rows[0]?.future_actionable ?? 0;

  const sampleResult = await db.pool.query(
    `SELECT reminder_id, amare_user_id, class_start_at, scheduled_for, status
       FROM amare_class_reminders
      WHERE status IN ('scheduled', 'due')
        AND sent_at IS NULL
        AND class_start_at IS NOT NULL
        AND class_start_at <= $1::timestamptz
      ORDER BY class_start_at
      LIMIT 10`,
    [now],
  );

  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "dry_run",
        reason: "expired_past_class",
        terminal_status: "suppressed",
        affected_count: affected,
        future_actionable_in_36h_window: futureActionable,
        sample_ids: sampleResult.rows.map((r) => r.reminder_id),
        sample_rows: sampleResult.rows,
      },
      null,
      2,
    ),
  );

  if (!execute) {
    console.log("\nDRY RUN ONLY — no rows updated. Re-run with --execute when separately authorized.");
    await db.pool.end();
    return;
  }

  const updateResult = await db.pool.query(
    `UPDATE amare_class_reminders
        SET status = 'suppressed',
            claimed_at = NULL,
            updated_at = NOW()
      WHERE status IN ('scheduled', 'due')
        AND sent_at IS NULL
        AND class_start_at IS NOT NULL
        AND class_start_at <= $1::timestamptz
      RETURNING reminder_id`,
    [now],
  );
  console.log(`\nEXECUTED — updated ${updateResult.rowCount} row(s) to suppressed.`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
