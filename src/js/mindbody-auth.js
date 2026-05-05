/**
 * Mindbody OAuth strip — shared by schedule (`classes-api`) and `/login`.
 * Expects Netlify redirects → `/.netlify/functions/mindbody-oauth-*`.
 */
(function () {
  const strip = document.getElementById("mb-auth-strip");
  if (!strip) return;

  function returnTarget() {
    const fromData = strip.getAttribute("data-mb-return");
    if (fromData && fromData.trim()) return fromData.trim();
    return window.location.pathname + window.location.search;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isLoggedInPayload(j) {
    if (!j || typeof j !== "object") return false;
    if (j.authenticated === false || j.loggedIn === false) return false;
    if (
      j.email ||
      j.name ||
      j.displayName ||
      j.given_name ||
      j.family_name ||
      j.sub
    )
      return true;
    if (j.authenticated === true || j.loggedIn === true) return true;
    return false;
  }

  /** Human-friendly label — avoid showing raw OIDC `sub` when email/name exist. */
  function displayLabel(j) {
    const name = pickName(j) || j.name || "";
    const email = j.email || "";
    if (email && name) return `${name} (${email})`;
    if (email) return email;
    if (name) return name;
    return "Member";
  }

  function renderLoggedIn(who, retParam) {
    strip.classList.add("mb-auth-bar--logged-in");
    strip.innerHTML = `
      <span class="mb-auth-bar__who">Signed in as ${escapeHtml(who)}</span>
      <a class="mb-auth-bar__out btn btn--ghost" href="/api/mindbody/oauth/logout${retParam}">Sign out</a>
    `;
  }

  function renderLoggedOut(retParam) {
    strip.classList.remove("mb-auth-bar--logged-in");
    strip.innerHTML = `
      <span class="mb-auth-bar__hint">Connect your Mindbody member account (same login as the studio app).</span>
      <a class="mb-auth-bar__cta btn btn--cream" href="/api/mindbody/oauth/start${retParam}">Sign in with Mindbody</a>
    `;
  }

  async function refresh() {
    strip.hidden = false;
    strip.classList.remove("mb-auth-bar--logged-in");
    const hint = strip.querySelector(".mb-auth-bar__hint");
    if (hint) hint.textContent = "Checking account…";

    const ret = encodeURIComponent(returnTarget());
    const retParam = `?return=${ret}`;

    let data = null;
    try {
      const res = await fetch("/api/mindbody/oauth/session", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (res.ok) data = await res.json();
    } catch (_) {
      renderLoggedOut(retParam);
      return;
    }

    if (isLoggedInPayload(data)) {
      const who = displayLabel(data);
      renderLoggedIn(who, retParam);
    } else {
      renderLoggedOut(retParam);
    }
  }

  void refresh();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
})();
