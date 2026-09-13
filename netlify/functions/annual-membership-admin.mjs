/**
 * Local dev + QA router for /api/admin/annual-memberships.
 * Production routes GET and POST to dedicated functions (see netlify.toml).
 */

import { handler as readHandler } from "./annual-membership-admin-read.mjs";
import { handler as mutateHandler } from "./annual-membership-admin-mutate.mjs";

/** @param {import("@netlify/functions").HandlerEvent} event */
export async function handler(event) {
  const method = String(event.httpMethod || "").toUpperCase();
  if (method === "POST" || method === "OPTIONS") {
    return mutateHandler(event);
  }
  return readHandler(event);
}
