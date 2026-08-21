(function (g) {
  "use strict";

  function mbApiPath(path) {
    const root = document.querySelector("[data-mb-proxy]");
    const origin = root && root.getAttribute("data-mb-proxy");
    if (origin && origin.indexOf("http") === 0) {
      return origin.replace(/\/$/, "") + path;
    }
    return path;
  }

  function hide(el) {
    if (el) el.hidden = true;
  }

  function show(el) {
    if (el) el.hidden = false;
  }

  function renderCard(mount, data) {
    if (!mount) return;
    const cta = String(data?.cta || "");
    const copy = data?.copy || {};
    const showCard = cta === "topup" || cta === "upgrade_monthly_8" || cta === "go_unlimited";
    if (!showCard) {
      hide(mount);
      return;
    }
    mount.replaceChildren();
    const inner = document.createElement("div");
    inner.className = "mb-schedule-guest-pass__inner mb-schedule-topup__inner";
    inner.setAttribute("role", "region");
    inner.setAttribute("aria-label", copy.eyebrow || "Member top-up");

    const eyebrow = document.createElement("p");
    eyebrow.className = "mb-schedule-guest-pass__eyebrow";
    eyebrow.textContent = copy.eyebrow || "Need one more class?";

    const hint = document.createElement("p");
    hint.className = "mb-schedule-guest-pass__hint";
    hint.textContent = copy.support || "One member top-up per billing cycle.";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--cream mb-schedule-guest-pass__cta";
    btn.textContent = copy.button || "Add 1 Class · $29";
    btn.addEventListener("click", () => {
      if (cta === "topup") void startTopUpCheckout(btn);
      else window.location.href = "/pricing";
    });

    inner.append(eyebrow, hint, btn);
    mount.append(inner);
    show(mount);
  }

  async function startTopUpCheckout(btn) {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening checkout…";
    try {
      const res = await fetch(mbApiPath("/api/stripe/checkout/create-session"), {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          localSku: "monthly_member_topup",
          ctaLocation: "member_topup",
          pageLocation: String(location.pathname || "/classes").slice(0, 200),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && typeof data.url === "string" && data.url) {
        window.location.href = data.url;
        return;
      }
      btn.textContent = data.message || "Unavailable right now";
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = prev;
      }, 2200);
    } catch {
      btn.textContent = "Try again";
      btn.disabled = false;
    }
  }

  async function loadStatus() {
    const res = await fetch(mbApiPath("/api/mindbody/member/top-up/status"), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  function boot() {
    const scheduleMount = document.getElementById("mb-schedule-topup");
    const memberMount = document.getElementById("mb-member-topup");
    if (!scheduleMount && !memberMount) return;
    void loadStatus().then((data) => {
      if (!data) return;
      renderCard(scheduleMount, data);
      renderCard(memberMount, data);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
