/**
 * Read-only QA SQL DATE evidence for pre-production audit.
 * Does NOT mutate data.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { annualMembershipQuery } from "../netlify/functions/annual-membership-store.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = path.join(root, ".cursor-local-db-url.txt");
if (fs.existsSync(dbFile)) {
  process.env.NETLIFY_DB_URL = fs.readFileSync(dbFile, "utf8").trim();
}

const terms = await annualMembershipQuery(
  `SELECT id, sku, status, stripe_subscription_id,
          term_start_date::text AS term_start,
          term_end_date::text AS term_end
     FROM annual_memberships
    WHERE mindbody_client_id = 100002839
      AND sku IN ('annual_monthly_5', 'annual_monthly_8')
    ORDER BY created_at DESC`,
  [],
);

for (const t of terms.rows) {
  const periods = await annualMembershipQuery(
    `SELECT period_index,
            period_start_date::text AS p_start,
            period_end_date::text AS p_end
       FROM annual_membership_periods
      WHERE annual_membership_id = $1
        AND period_index IN (0, 1)
      ORDER BY period_index`,
    [t.id],
  );
  console.log(JSON.stringify({ term: t, periods: periods.rows }, null, 2));
}
