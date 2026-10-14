import { apiJson } from "./client";
import { withMobileRequestTelemetry } from "./mobile-request-telemetry";

export type ClassBookResponse = {
  visitId?: number;
  waitlistEntryId?: number;
  ok?: boolean;
};

/** POST /api/mindbody/class/book with optional native client diagnostics. */
export async function postClassBook(
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<ClassBookResponse> {
  const body = await withMobileRequestTelemetry(payload);
  return apiJson<ClassBookResponse>("/api/mindbody/class/book", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
