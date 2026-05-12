/**
 * Header "Members" link personalisation.
 *
 * Two-stage flow to avoid the "Members → flash → Snir" flicker on every page load:
 *
 *   STAGE 1 — Inline pre-paint script (rendered by `scripts/build.mjs` right after
 *   the header element). Reads `localStorage["amare-mb-header"]` synchronously
 *   before the browser paints the header, so repeat visits show the cached first
 *   name immediately. See `renderHeaderHydrationScript()` in build.mjs.
 *
 *   STAGE 2 — This deferred script. Calls `GET /api/mindbody/oauth/session` to:
 *     • Verify the cookie is still valid
 *     • Refresh the cached first name if Mindbody returned a new one
 *     • Clear the cache when the visitor has signed out (so the next page load
 *       reverts to "Members" without an inverse flicker)
 *
 * Why a dedicated file (separate from `mindbody-auth.js`):
 *   `mindbody-auth.js` only bootstraps when `#mb-auth-strip` is present (limited
 *   to `/classes`, `/login`, etc.), but the Members button is in every header.
 *
 * Cost: a single same-origin fetch per page load. `/oauth/session` only unseals
 * the sealed cookie — it does NOT call the Mindbody refresh endpoint.
 *
 * Cache TTL: kept in sync with the inline pre-paint script (24h). After 24h the
 * inline script ignores the cache and falls back to the static "Members" label
 * until the deferred fetch confirms the session.
 */
(function headerMembersPersonalisationBootstrap() {
  /** Mirror of the constants used by the inline pre-paint script in build.mjs. */
  const CACHE_KEY = "amare-mb-header";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  const link = /** @type {HTMLAnchorElement | null} */ (document.querySelector(".header-members"));
  if (!link) return;
  const labelEl = /** @type {HTMLElement | null} */ (link.querySelector(".header-members__label"));
  if (!labelEl) return;

  function clearCache() {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* localStorage may throw in private mode / disabled storage — ignore. */
    }
  }

  function writeCache(/** @type {string} */ name) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ name, ts: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function resetLabelToDefault() {
    labelEl.textContent = "Members";
    link.setAttribute("aria-label", "Members area");
    link.removeAttribute("data-mb-signed-in");
  }

  /** Reuse the schedule-proxy origin if any element on the page advertises one. Empty = same origin. */
  function readProxyOrigin() {
    const holder = document.querySelector("[data-mb-proxy]");
    if (!(holder instanceof HTMLElement)) return "";
    const raw = typeof holder.dataset.mbProxy === "string" ? holder.dataset.mbProxy.trim() : "";
    return raw.replace(/\/$/, "");
  }

  function mbApiPath(/** @type {string} */ p) {
    const origin = readProxyOrigin();
    const path = p.startsWith("/") ? p : `/${p}`;
    return origin ? `${origin}${path}` : path;
  }

  function fetchHeaders() {
    /** @type {Record<string, string>} */
    const out = { Accept: "application/json" };
    let host = "";
    try {
      const origin = readProxyOrigin();
      host = origin ? new URL(origin, window.location.href).hostname : window.location.hostname;
    } catch {
      host = typeof window !== "undefined" ? window.location.hostname : "";
    }
    if (host && host.includes("ngrok")) out["ngrok-skip-browser-warning"] = "true";
    return out;
  }

  function isLoggedInPayload(/** @type {unknown} */ j) {
    if (!j || typeof j !== "object") return false;
    /** @type {Record<string, unknown>} */
    const o = j;
    if (o.authenticated === false || o.loggedIn === false) return false;
    if (o.email || o.name || o.displayName || o.given_name || o.family_name || o.sub) return true;
    if (o.authenticated === true || o.loggedIn === true) return true;
    return false;
  }

  /** Prefer `given_name` (OIDC standard); else first word of `name`/`displayName`; else email local-part. */
  function pickFirstName(/** @type {Record<string, unknown>} */ payload) {
    if (typeof payload.given_name === "string" && payload.given_name.trim()) {
      return payload.given_name.trim();
    }
    if (typeof payload.name === "string" && payload.name.trim()) {
      const first = payload.name.trim().split(/\s+/)[0];
      if (first) return first;
    }
    if (typeof payload.displayName === "string" && payload.displayName.trim()) {
      const first = payload.displayName.trim().split(/\s+/)[0];
      if (first) return first;
    }
    if (typeof payload.email === "string" && payload.email.trim()) {
      const local = payload.email.trim().split("@")[0];
      if (local) return local;
    }
    return "";
  }

  /** Capitalise first letter (handles email-derived names like "snir3" gracefully). */
  function titleise(/** @type {string} */ name) {
    if (!name) return "";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** Defensively prune cache entries older than the TTL — keeps `localStorage` tidy if the user disables JS later. */
  function pruneStaleCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") {
        clearCache();
        return;
      }
      const ts = typeof data.ts === "number" ? data.ts : 0;
      if (!ts || Date.now() - ts > CACHE_TTL_MS) clearCache();
    } catch {
      clearCache();
    }
  }

  pruneStaleCache();

  void (async () => {
    /** @type {Response | null} */
    let res = null;
    try {
      res = await fetch(mbApiPath("/api/mindbody/oauth/session"), {
        credentials: "include",
        headers: fetchHeaders(),
      });
    } catch {
      /* Network error — keep whatever the inline script already painted. */
      return;
    }

    /** Treat any non-2xx as "not logged in" — clear cache so the next page load shows "Members". */
    if (!res.ok) {
      clearCache();
      if (link.getAttribute("data-mb-signed-in") === "1") resetLabelToDefault();
      return;
    }

    /** @type {unknown} */
    let data = null;
    try {
      data = await res.json();
    } catch {
      return;
    }

    if (!isLoggedInPayload(data)) {
      clearCache();
      if (link.getAttribute("data-mb-signed-in") === "1") resetLabelToDefault();
      return;
    }

    const firstName = titleise(pickFirstName(/** @type {Record<string, unknown>} */ (data)));
    if (!firstName) return;

    /** Write fresh cache regardless of current label state — covers the "name changed in Mindbody" edge case too. */
    writeCache(firstName);

    /** Skip DOM writes when the inline script already painted the same name (avoids unnecessary layout). */
    if (labelEl.textContent === firstName && link.getAttribute("data-mb-signed-in") === "1") return;

    labelEl.textContent = firstName;
    link.setAttribute("aria-label", `Members area — signed in as ${firstName}`);
    link.setAttribute("data-mb-signed-in", "1");
  })();
})();
