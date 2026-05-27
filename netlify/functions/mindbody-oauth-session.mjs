import {
  cookieSecureFlag,
  parseCookies,
  sessionSecret,
  unsealCookiePayload,
} from "./oauth-lib.mjs";
import {
  getSessionWithConsumerHeaders,
  resolveSessionStudioLinkFlags,
} from "./mindbody-consumer-lib.mjs";

/**
 * Session probe for the schedule / member UI.
 *
 * Historically this only **unsealed** `mb_sess`, so the strip could show “signed in” while
 * `GET …/member/summary` returned **401** (refresh failed: invalid_grant, stale tunnel URL, etc.).
 * That left `enrollVisitByClassId` empty — no “booked” / cancel state after a real booking.
 *
 * Now we **validate** with the same refresh path as consumer API routes; on failure we clear the cookie.
 */
export async function handler(event) {
  try {
    const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
    const hadCookie = !!parseCookies(cookieHeader).mb_sess;

    const clearCookie =
      "mb_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + cookieSecureFlag(event.headers);

    const auth = await getSessionWithConsumerHeaders(event);

    if (!auth.ok) {
      const r = auth.response;
      const status = typeof r.statusCode === "number" ? r.statusCode : 500;

      if (status === 401 && hadCookie) {
        /**
         * Cookie unsealed but Mindbody refresh failed → we are about to clear it.
         * Worth logging: this is the moment a "looked signed in" user becomes signed out
         * mid-session, and pairs with the next page's class_book attempt that would have
         * shown "Sign in expired" to the user.
         */
        console.warn(
          JSON.stringify({
            event: "oauth_session_cleared_after_refresh_failure",
            statusFromConsumerHeaders: status,
          }),
        );
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": clearCookie,
          },
          body: JSON.stringify({ authenticated: false, loggedIn: false }),
        };
      }

      if (status === 401 && !hadCookie) {
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ authenticated: false, loggedIn: false }),
        };
      }

      /**
       * 503 proxy misconfiguration — preserve dev UX: strip can still echo sealed profile.
       * `session_consumer_unverified` lets clients know APIs may still 401.
       */
      if (hadCookie) {
        try {
          const secret = sessionSecret();
          const raw = parseCookies(cookieHeader).mb_sess;
          if (!raw) throw new Error("missing_cookie");
          const data = unsealCookiePayload(raw, secret);
          return {
            statusCode: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
            body: JSON.stringify({
              authenticated: true,
              loggedIn: true,
              email: data.email ?? null,
              name: data.name ?? null,
              sub: data.sub ?? null,
              session_consumer_unverified: true,
            }),
          };
        } catch {
          /* fall through */
        }
      }

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ authenticated: false, loggedIn: false }),
      };
    }

    const s = auth.session;
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (auth.setCookie) headers["Set-Cookie"] = auth.setCookie;

    /**
     * Single line per signed-in /classes (and /pricing) page load. With this we can grep
     * an email and see exactly which sessions are "live" right now — including the cookie
     * age and the client_id baked into the cookie at OAuth callback time. Critical for
     * diagnosing the "user looks signed in but with the wrong client" class of failures.
     */
    const sessionAtRaw = s.at;
    const sessionAtMs = typeof sessionAtRaw === "number" && Number.isFinite(sessionAtRaw) ? sessionAtRaw : null;
    const link = await resolveSessionStudioLinkFlags(s, auth.authHeaders);

    console.log(
      JSON.stringify({
        event: "oauth_session_authenticated",
        email: typeof s.email === "string" ? s.email : null,
        sub: typeof s.sub === "string" ? s.sub : null,
        cookieClientId: s.client_id ?? null,
        clientId: link.clientId,
        clientExists: link.clientExists,
        consumerAssociated: link.consumerAssociated,
        bookingAllowed: link.bookingAllowed,
        linkStatus: link.linkStatus,
        sessionAtMs,
        sessionAgeMs: sessionAtMs != null ? Date.now() - sessionAtMs : null,
        rotatedRefreshToken: !!auth.setCookie,
      }),
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        authenticated: true,
        loggedIn: true,
        email: typeof s.email === "string" ? s.email : null,
        name: typeof s.name === "string" ? s.name : null,
        sub: typeof s.sub === "string" ? s.sub : null,
        clientId: link.clientId,
        clientExists: link.clientExists,
        consumerAssociated: link.consumerAssociated,
        bookingAllowed: link.bookingAllowed,
        linkStatus: link.linkStatus,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(e?.message ?? e) }),
    };
  }
}
