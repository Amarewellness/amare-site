import {
  fetchMindbodyConsumerStoredWalletCards,
  jsonResponse,
  resolveConsumerClient,
} from "./mindbody-consumer-lib.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const ctx = await resolveConsumerClient(event);
  if (!ctx.ok) return ctx.response;

  const hdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  const w = await fetchMindbodyConsumerStoredWalletCards(ctx.clientId, ctx.authHeaders);

  if (!w.cciOk) {
    return jsonResponse(w.cciHttpStatus, { ok: false, error: "clientcompleteinfo_failed", mindbody: w.cciBody }, hdr);
  }

  return jsonResponse(
    200,
    {
      ok: true,
      clientId: ctx.clientId,
      cards: w.cards,
    },
    hdr,
  );
}
