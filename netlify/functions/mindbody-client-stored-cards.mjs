import {
  fetchMindbodyConsumerStoredWalletCards,
  isWalletDebugGateOpen,
  jsonResponse,
  reliableLastFourFromWalletCards,
  walletCardsWithReliableLastFourCount,
  resolveConsumerClient,
} from "./mindbody-consumer-lib.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const params = event.queryStringParameters || {};
  const wantWalletDebug = params.debugWallet === "1" && isWalletDebugGateOpen(event);

  const ctx = await resolveConsumerClient(event, { walletDebug: wantWalletDebug });
  if (!ctx.ok) return ctx.response;

  const hdr = ctx.setCookie ? { "Set-Cookie": ctx.setCookie } : {};
  const w = await fetchMindbodyConsumerStoredWalletCards(ctx.clientId, ctx.authHeaders, {
    walletDebug: wantWalletDebug,
  });

  const cardCount = walletCardsWithReliableLastFourCount(w.cards);
  const hasStoredCard = reliableLastFourFromWalletCards(w.cards) != null;

  /** Public JSON must not expose last-four / PAN metadata — only eligibility for PurchaseContract `{ LastFour }` flow. */
  if (hasStoredCard) {
    return jsonResponse(
      200,
      {
        ok: true,
        clientId: ctx.clientId,
        hasStoredCard: true,
        cardCount,
        ...(wantWalletDebug && ctx.clientResolution
          ? {
              clientResolution: ctx.clientResolution,
              walletDebug: w.walletDebug,
              walletDebugNote:
                "Safe metadata only: no PAN, CVV, tokens, or raw billing values. Remove ?debugWallet=1 after diagnosis.",
              runtime: {
                netlifyContext: process.env.CONTEXT || null,
                nodeEnv: process.env.NODE_ENV || null,
              },
            }
          : {}),
      },
      hdr,
    );
  }

  /** Nothing parsed and every Mindbody call failed — surface an error so the UI does not assume “no card on file” (Classic redirect). */
  if (!w.anyMindbodyRequestSucceeded) {
    return jsonResponse(
      502,
      {
        ok: false,
        error: "mindbody_wallet_unavailable",
        detail:
          "Could not reach Mindbody client endpoints for saved payment eligibility. Check API keys, site id, and tunnel routing to Netlify functions.",
        mindbody: w.cciBody,
        ...(wantWalletDebug && ctx.clientResolution
          ? {
              clientResolution: ctx.clientResolution,
              walletDebug: w.walletDebug,
              walletDebugNote:
                "Safe metadata only: no PAN, CVV, tokens, or raw billing values. Remove ?debugWallet=1 after diagnosis.",
              runtime: {
                netlifyContext: process.env.CONTEXT || null,
                nodeEnv: process.env.NODE_ENV || null,
              },
            }
          : {}),
      },
      hdr,
    );
  }

  const staffEnvConfigured =
    (Boolean(process.env.MINDBODY_STAFF_USERNAME?.trim()) &&
      typeof process.env.MINDBODY_STAFF_PASSWORD === "string" &&
      process.env.MINDBODY_STAFF_PASSWORD !== "") ||
    Boolean(process.env.MINDBODY_STAFF_USER_TOKEN?.trim());

  const staffRanWithHeaders = w.staffWalletProbe?.staffHeadersAvailable === true;
  const walletHint = !staffEnvConfigured
    ? "set_MINDBODY_STAFF_USERNAME_PASSWORD_or_STAFF_USER_TOKEN_staff_sees_cards_consumer_hides"
    : staffRanWithHeaders
      ? "mindbody_did_not_expose_stored_card_data_for_this_client_through_tested_public_api_endpoints"
      : "mindbody_returned_no_card_rows_for_this_client";

  return jsonResponse(
    200,
    {
      ok: true,
      clientId: ctx.clientId,
      hasStoredCard: false,
      cardCount: 0,
      walletHint,
      staffProbe: w.staffWalletProbe ?? {
        attempted: false,
        staffHeadersAvailable: false,
        cciScoped: false,
      },
      ...(wantWalletDebug
        ? {
            clientResolution: ctx.clientResolution,
            walletDebug: w.walletDebug,
            walletDebugNote:
              "Safe metadata only: no PAN, CVV, tokens, or raw billing values. Remove ?debugWallet=1 after diagnosis.",
            runtime: {
              netlifyContext: process.env.CONTEXT || null,
              nodeEnv: process.env.NODE_ENV || null,
            },
          }
        : {}),
    },
    hdr,
  );
}
