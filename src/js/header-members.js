/**
 * Header "Members" link personalisation.
 *
 * Authentication state is AMARÉ customer state, not the sign-in provider.
 * Email OTP linked, Mindbody linked, and dual-aligned all render the same
 * signed-in header after cookies/session are validated.
 *
 * The AMARÉ probe is GENERAL AMARÉ signed-in state only. It never authorizes Book
 * or Cancel. Linked studio access (`/api/amare/auth/member-access`) may send
 * Members to `/member`.
 *
 * STAGE 1 — Inline pre-paint script (`renderHeaderHydrationScript` in
 * `scripts/build.mjs`). May show a generic "Account" placeholder from
 * `localStorage["amare-header-auth"]`. It never paints a cached personal name.
 * Legacy `amare-mb-header` is removed on sight.
 *
 * STAGE 2 — This deferred script. Probes AMARÉ and Mindbody in parallel.
 * A personal name is written only after the current session is validated.
 * Cache is provider-neutral and stores a session key (not a name). It is
 * cleared on every signed-out / logout / identity-change transition.
 */
(function headerMembersPersonalisationBootstrap() {
  const CACHE_KEY = "amare-header-auth";
  const LEGACY_CACHE_KEY = "amare-mb-header";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  const links = Array.from(document.querySelectorAll(".header-members"));
  if (!links.length) return;

  function clearCache() {
    try {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(LEGACY_CACHE_KEY);
    } catch {
      /* localStorage may throw in private mode / disabled storage — ignore. */
    }
  }

  /**
   * @param {{ sessionKey: string }} payload
   */
  function writeCache(payload) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          signedIn: true,
          sessionKey: payload.sessionKey,
          ts: Date.now(),
        }),
      );
      localStorage.removeItem(LEGACY_CACHE_KEY);
    } catch {
      /* ignore */
    }
  }

  function resetLinkToDefault(/** @type {HTMLAnchorElement} */ link) {
    const labelEl = link.querySelector(".header-members__label");
    if (labelEl) labelEl.textContent = "Members";
    link.setAttribute("aria-label", "Members area");
    link.removeAttribute("data-mb-signed-in");
    link.removeAttribute("data-amare-signed-in");
    if (amareAuthUiEnabled(link)) link.setAttribute("href", loginHref());
  }

  function applySignedIn(/** @type {HTMLAnchorElement} */ link, firstName, href) {
    const labelEl = link.querySelector(".header-members__label");
    const label = firstName || "Account";
    if (labelEl) labelEl.textContent = label;
    link.setAttribute(
      "aria-label",
      firstName ? `Account — signed in as ${firstName}` : "Account — signed in",
    );
    link.setAttribute("href", href);
    link.setAttribute("data-amare-signed-in", "1");
    link.removeAttribute("data-mb-signed-in");
  }

  function amareAuthUiEnabled(/** @type {HTMLAnchorElement | null} */ link) {
    return (
      document.body.getAttribute("data-amare-auth-ui") === "1" ||
      (link && link.getAttribute("data-amare-auth-ui") === "1")
    );
  }

  function safeReturnPath(raw) {
    const value = String(raw || "").split("?")[0] || "/";
    if (!value.startsWith("/") || value.startsWith("//")) return "/classes";
    if (!/^\/[\w\-./]*$/.test(value)) return "/classes";
    if (value === "/login" || value.startsWith("/login/")) return "/classes";
    if (value === "/member.html") return "/member";
    if (value === "/classes.html") return "/classes";
    if (value === "/pricing.html") return "/pricing";
    return value || "/classes";
  }

  function loginHref() {
    return `/login?return=${encodeURIComponent(safeReturnPath(window.location.pathname || "/classes"))}`;
  }

  function memberHref() {
    return "/member";
  }

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

  function titleise(/** @type {string} */ name) {
    if (!name) return "";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function sessionKeyFrom(amareUserId, mbKey) {
    const parts = [];
    if (amareUserId) parts.push(`amare:${amareUserId}`);
    if (mbKey) parts.push(`mb:${mbKey}`);
    return parts.join("|") || "signed-in";
  }

  function pruneStaleCache() {
    try {
      localStorage.removeItem(LEGACY_CACHE_KEY);
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || data.signedIn !== true) {
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

  for (const link of links) {
    if (amareAuthUiEnabled(link) && link instanceof HTMLAnchorElement) {
      link.setAttribute("href", loginHref());
    }
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest("[data-amare-logout-all]") || t.closest("#amare-login-logout") || t.closest("#amare-login-logout-all")) {
      clearCache();
      return;
    }
    const a = t.closest("a");
    const href = a ? a.getAttribute("href") || "" : "";
    if (/\/api\/(amare\/auth\/logout|mindbody\/oauth\/logout)/.test(href)) clearCache();
  });

  void (async () => {
    const uiOn = links.some((link) => amareAuthUiEnabled(link));
    /** @type {[Promise<Response | null>, Promise<Response | null>]} */
    const probes = [
      fetch(mbApiPath("/api/mindbody/oauth/session"), {
        credentials: "include",
        headers: fetchHeaders(),
      }).catch(() => null),
      uiOn
        ? fetch("/api/amare/auth/session", {
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          }).catch(() => null)
        : Promise.resolve(null),
    ];
    const [mbRes, amareRes] = await Promise.all(probes);

    /** @type {Record<string, unknown> | null} */
    let mbData = null;
    let mbIn = false;
    if (mbRes && mbRes.ok) {
      try {
        const parsed = await mbRes.json();
        if (isLoggedInPayload(parsed)) {
          mbData = /** @type {Record<string, unknown>} */ (parsed);
          mbIn = true;
        }
      } catch {
        mbData = null;
      }
    }

    let amareIn = false;
    /** @type {string} */
    let amareUserId = "";
    if (amareRes && amareRes.ok) {
      try {
        const amare = await amareRes.json();
        if (amare && amare.signedIn === true) {
          amareIn = true;
          if (typeof amare.amareUserId === "string") amareUserId = amare.amareUserId;
        }
      } catch {
        amareIn = false;
      }
    }

    if (!mbIn && !amareIn) {
      clearCache();
      for (const link of links) {
        if (link instanceof HTMLAnchorElement) resetLinkToDefault(link);
      }
      return;
    }

    let firstName = mbData ? titleise(pickFirstName(mbData)) : "";
    let href = memberHref();
    let accessLinked = mbIn;
    if (amareIn) {
      try {
        const accessRes = await fetch("/api/amare/auth/member-access", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const access = accessRes.ok ? await accessRes.json() : null;
        if (access && access.studioAccess === "linked") accessLinked = true;
        const accessName = access ? titleise(pickFirstName(access)) : "";
        if (accessName) firstName = accessName;
      } catch {
        /* Keep generic signed-in header until linked access is confirmed. */
      }
      if (!accessLinked && !mbIn) href = loginHref();
    }

    const mbKey =
      mbData && typeof mbData.sub === "string" && mbData.sub
        ? mbData.sub
        : mbData && typeof mbData.email === "string" && mbData.email
          ? mbData.email
          : mbIn
            ? "mb"
            : "";
    writeCache({ sessionKey: sessionKeyFrom(amareUserId, mbKey) });

    for (const link of links) {
      if (link instanceof HTMLAnchorElement) applySignedIn(link, firstName, href);
    }
  })();
})();
