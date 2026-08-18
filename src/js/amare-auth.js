/**
 * AMARÉ launch login UI (2A.7).
 * Email OTP primary. Mindbody fallback via existing OAuth start.
 * HttpOnly amare_sess is authority — nothing is stored in localStorage.
 */
(function () {
  const root = document.querySelector(".amare-login-page");
  if (!root) return;

  const uiOn = root.getAttribute("data-amare-auth-ui") === "1";
  const panel = document.getElementById("amare-login");
  const legacy = document.getElementById("amare-login-legacy");
  if (!uiOn) {
    if (panel) panel.hidden = true;
    if (legacy) legacy.hidden = false;
    return;
  }
  if (panel) panel.hidden = false;
  if (legacy) legacy.hidden = true;

  const emailStep = document.getElementById("amare-login-email-step");
  const otpStep = document.getElementById("amare-login-otp-step");
  const claimStep = document.getElementById("amare-login-claim-step");
  const claimMismatchStep = document.getElementById("amare-login-claim-mismatch-step");
  const claimEmailEl = document.getElementById("amare-login-claim-email");
  const claimRejectBtn = document.getElementById("amare-login-claim-reject");
  const claimUseDifferentBtn = document.getElementById("amare-login-claim-use-different");
  const profileStep = document.getElementById("amare-login-profile-step");
  const unavailableStep = document.getElementById("amare-login-unavailable-step");
  const signedInStep = document.getElementById("amare-login-signedin-step");
  const profileForm = document.getElementById("amare-login-profile-form");
  const profileError = document.getElementById("amare-login-profile-error");
  const profileCreateBtn = document.getElementById("amare-login-profile-create");
  const firstNameInput = document.getElementById("amare-login-first-name");
  const lastNameInput = document.getElementById("amare-login-last-name");
  const phoneInput = document.getElementById("amare-login-phone");
  const unavailableRetryBtn = document.getElementById("amare-login-unavailable-retry");
  const fallback = document.getElementById("amare-login-fallback");
  const emailForm = document.getElementById("amare-login-email-form");
  const otpForm = document.getElementById("amare-login-otp-form");
  const emailInput = document.getElementById("amare-login-email");
  const emailError = document.getElementById("amare-login-email-error");
  const otpError = document.getElementById("amare-login-otp-error");
  const claimError = document.getElementById("amare-login-claim-error");
  const otpLede = document.getElementById("amare-login-otp-lede");
  const continueBtn = document.getElementById("amare-login-continue");
  const verifyBtn = document.getElementById("amare-login-verify");
  const resendBtn = document.getElementById("amare-login-resend");
  const resendWait = document.getElementById("amare-login-resend-wait");
  const statusEl = document.getElementById("amare-login-status");
  const mindbodyLink = document.getElementById("amare-login-mindbody");
  const destLink = document.getElementById("amare-login-continue-dest");
  const claimConfirmBtn = document.getElementById("amare-login-claim-confirm");
  const claimNewBtn = document.getElementById("amare-login-claim-new");
  const logoutBtn = document.getElementById("amare-login-logout");
  const logoutAllBtn = document.getElementById("amare-login-logout-all");
  const otpDigits = Array.from(document.querySelectorAll(".amare-login__otp-digit"));

  const RESEND_COOLDOWN_MS = 60 * 1000;
  let lastMaskedEmail = "";
  const orderIdHint = /^ord_[A-Z0-9]{8,40}$/i.test(String(new URLSearchParams(window.location.search || "").get("order") || "").trim())
    ? String(new URLSearchParams(window.location.search || "").get("order") || "").trim()
    : "";
  let pendingEmail = "";
  let claimMode = "";
  let resendTimer = null;
  let busy = false;

  function safeReturnPath(raw) {
    const value = String(raw || "").trim();
    if (!value.startsWith("/") || value.startsWith("//")) return "/classes";
    if (!/^\/[\w\-./]*$/.test(value.split("?")[0] || "")) return "/classes";
    if (value === "/login" || value.startsWith("/login?")) return "/classes";
    return value.split("?")[0] || "/classes";
  }

  function returnPath() {
    const params = new URLSearchParams(window.location.search || "");
    return safeReturnPath(params.get("return") || params.get("next") || "/classes");
  }

  function maskEmail(email) {
    const normalized = String(email || "").trim();
    const at = normalized.indexOf("@");
    if (at < 1) return "your email";
    const local = normalized.slice(0, at);
    const domain = normalized.slice(at + 1);
    return `${local.slice(0, 1)}••••@${domain}`;
  }

  function showError(el, message, field) {
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    if (field) field.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message || "";
  }

  function showStep(name) {
    if (emailStep) emailStep.hidden = name !== "email";
    if (otpStep) otpStep.hidden = name !== "otp";
    if (claimStep) claimStep.hidden = name !== "claim";
    if (claimMismatchStep) claimMismatchStep.hidden = name !== "claim_mismatch";
    if (profileStep) profileStep.hidden = name !== "profile";
    if (unavailableStep) unavailableStep.hidden = name !== "unavailable";
    if (signedInStep) signedInStep.hidden = name !== "signedin";
    if (fallback) fallback.hidden = name === "signedin";
  }

  function otpValue() {
    return otpDigits.map((input) => String(input.value || "").replace(/\D/g, "")).join("").slice(0, 6);
  }

  function setOtpValue(code) {
    const digits = String(code || "").replace(/\D/g, "").slice(0, 6).split("");
    otpDigits.forEach((input, i) => {
      input.value = digits[i] || "";
    });
  }

  function startResendCountdown() {
    const started = Date.now();
    if (resendBtn) resendBtn.disabled = true;
    const tick = () => {
      const left = Math.max(0, RESEND_COOLDOWN_MS - (Date.now() - started));
      if (resendWait) {
        resendWait.textContent = left > 0 ? `You can resend in ${Math.ceil(left / 1000)}s` : "";
      }
      if (left <= 0) {
        if (resendBtn) resendBtn.disabled = false;
        if (resendTimer) window.clearInterval(resendTimer);
        resendTimer = null;
        return;
      }
    };
    tick();
    if (resendTimer) window.clearInterval(resendTimer);
    resendTimer = window.setInterval(tick, 250);
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  }

  async function getSession() {
    const res = await fetch("/api/amare/auth/session", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { signedIn: false };
    try {
      const json = await res.json();
      return json && json.signedIn === true ? { signedIn: true } : { signedIn: false };
    } catch {
      return { signedIn: false };
    }
  }

  async function getMemberAccess() {
    try {
      const res = await fetch("/api/amare/auth/member-access", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { signedIn: false, studioAccess: "none" };
      const json = await res.json();
      return json && typeof json === "object" ? json : { signedIn: false, studioAccess: "none" };
    } catch {
      return { signedIn: false, studioAccess: "none" };
    }
  }

  function finishSignedIn() {
    if (destLink) destLink.href = returnPath();
    showStep("signedin");
    setStatus("");
    window.setTimeout(() => {
      window.location.assign(returnPath());
    }, 400);
  }

  function showClaim(mode, maskedEmail) {
    claimMode = mode;
    const title = document.querySelector("#amare-login-claim-step .amare-login__title");
    const lede = document.getElementById("amare-login-claim-lede");
    const fromServer =
      typeof maskedEmail === "string" && maskedEmail.includes("@") ? maskedEmail : "";
    const fromPending = pendingEmail ? maskEmail(pendingEmail) : "";
    const safeMasked = fromServer || (fromPending.includes("@") ? fromPending : "your email");
    if (claimEmailEl) claimEmailEl.textContent = safeMasked;
    if (mode === "pending_link") {
      if (title) title.textContent = "Connect your studio profile";
      if (lede) {
        lede.textContent = "Confirm this studio profile so we can show your credits, packages, and visits.";
      }
      if (claimConfirmBtn) claimConfirmBtn.textContent = "Continue with this studio profile";
      if (claimNewBtn) claimNewBtn.hidden = true;
      if (claimRejectBtn) claimRejectBtn.hidden = true;
    } else if (mode === "pending_attach") {
      if (title) title.textContent = "We found your existing AMARÉ profile";
      if (lede) {
        lede.textContent = "Confirm this is you to continue.";
      }
      if (claimConfirmBtn) claimConfirmBtn.textContent = "Continue with this profile";
      if (claimNewBtn) claimNewBtn.hidden = false;
      if (claimRejectBtn) claimRejectBtn.hidden = true;
    } else {
      if (title) title.textContent = "We found your existing AMARÉ profile";
      if (lede) {
        lede.textContent = "";
        lede.appendChild(document.createTextNode("We found a studio profile connected to "));
        const strong = document.createElement("strong");
        strong.id = "amare-login-claim-email";
        strong.textContent = safeMasked;
        lede.appendChild(strong);
        lede.appendChild(
          document.createTextNode(
            ". Confirm this is your profile to access your existing purchases, credits, and bookings.",
          ),
        );
      }
      if (claimConfirmBtn) claimConfirmBtn.textContent = "Continue with this profile";
      if (claimNewBtn) claimNewBtn.hidden = true;
      if (claimRejectBtn) claimRejectBtn.hidden = false;
    }
    showStep("claim");
  }

  async function requestCode(email) {
    const result = await postJson("/api/amare/auth/email/request-code", { email });
    if (result.status === 400) return { ok: false, error: "invalid_email" };
    if (!result.ok) return { ok: false, error: "network" };
    return { ok: true };
  }

  function applyPurchaseConnectedCopy() {
    const title = document.querySelector("#amare-login-signedin-step .amare-login__title");
    const lede = document.querySelector("#amare-login-signedin-step .amare-login__lede");
    if (title) title.textContent = "Your purchase is connected";
    if (lede) {
      lede.textContent = "Your AMARÉ account is now connected to your studio profile and purchases.";
    }
  }

  async function afterVerify(json) {
    if (json && json.status === "pending_attach") {
      showClaim("pending_attach", json.maskedEmail);
      return;
    }
    if (json && typeof json.maskedEmail === "string" && json.maskedEmail.includes("@")) {
      lastMaskedEmail = json.maskedEmail;
    }
    if (json && json.purchaseConnected) applyPurchaseConnectedCopy();
    const claim = json && json.claimStatus;
    if (claim === "candidate") {
      showClaim("candidate", json.maskedEmail);
      return;
    }
    if (claim === "needs_profile") {
      showStep("profile");
      void refreshProfileTx();
      return;
    }
    if (claim === "search_unavailable") {
      showStep("unavailable");
      return;
    }
    if (claim === "conflict" || claim === "ambiguous") {
      showError(otpError, "We could not connect this sign-in to a studio profile. Please contact the studio.");
      return;
    }
    const session = await getSession();
    if (!session.signedIn) {
      showError(otpError, "We could not finish signing you in. Please try again.");
      return;
    }
    const access = await getMemberAccess();
    if (access.studioAccess === "verified_pending_link") {
      showClaim("pending_link", lastMaskedEmail);
      return;
    }
    if (access.studioAccess === "needs_profile") {
      showStep("profile");
      void refreshProfileTx();
      return;
    }
    if (access.studioAccess === "search_unavailable") {
      showStep("unavailable");
      return;
    }
    if (access.studioAccess === "conflict") {
      showError(otpError, "This browser has two different studio accounts. Sign out and try again.");
      return;
    }
    if (access.studioAccess === "candidate") {
      showClaim("candidate", lastMaskedEmail || maskEmail(access.email));
      return;
    }
    finishSignedIn();
  }

  async function refreshProfileTx() {
    await postJson("/api/amare/auth/profile/begin", {});
  }

  if (mindbodyLink) {
    mindbodyLink.href = `/api/mindbody/oauth/start?return=${encodeURIComponent(returnPath())}`;
  }
  if (destLink) destLink.href = returnPath();

  const params = new URLSearchParams(window.location.search || "");
  const hintedEmail = String(params.get("email") || params.get("login_hint") || "").trim();
  if (emailInput && hintedEmail.includes("@")) {
    emailInput.value = hintedEmail;
  }
  if (params.get("oauth_err")) {
    setStatus("Mindbody sign-in was canceled or could not be completed.");
  }
  if (params.get("amare_claim") === "pending_link") {
    showClaim("pending_attach", lastMaskedEmail);
  }

  getSession().then(async (session) => {
    if (!session.signedIn || params.get("amare_claim") === "pending_link") return;
    const access = await getMemberAccess();
    if (access.studioAccess === "verified_pending_link") {
      showClaim("pending_link", lastMaskedEmail);
      return;
    }
    if (access.studioAccess === "needs_profile") {
      showStep("profile");
      void refreshProfileTx();
      return;
    }
    if (access.studioAccess === "search_unavailable") {
      showStep("unavailable");
      return;
    }
    if (access.studioAccess === "candidate") {
      showClaim("candidate", lastMaskedEmail || maskEmail(access.email));
      return;
    }
    if (destLink) destLink.href = returnPath();
    showStep("signedin");
  });

  emailForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const email = String(emailInput?.value || "").trim();
    showError(emailError, "", emailInput);
    if (!email || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
      showError(emailError, "Enter a valid email address.", emailInput);
      emailInput?.focus();
      return;
    }
    busy = true;
    if (continueBtn) continueBtn.disabled = true;
    setStatus("Sending your code…");
    try {
      const sent = await requestCode(email);
      if (!sent.ok && sent.error === "invalid_email") {
        showError(emailError, "Enter a valid email address.", emailInput);
        return;
      }
      if (!sent.ok) {
        showError(emailError, "We could not send a code right now. Please try again.", emailInput);
        return;
      }
      pendingEmail = email;
      if (otpLede) otpLede.textContent = `We sent a 6-digit code to ${maskEmail(email)}.`;
      setOtpValue("");
      showStep("otp");
      showError(otpError, "");
      setStatus("");
      startResendCountdown();
      otpDigits[0]?.focus();
    } catch {
      showError(emailError, "We could not send a code right now. Please try again.", emailInput);
    } finally {
      busy = false;
      if (continueBtn) continueBtn.disabled = false;
    }
  });

  otpDigits.forEach((input, index) => {
    input.addEventListener("input", () => {
      const cleaned = String(input.value || "").replace(/\D/g, "");
      if (cleaned.length > 1) {
        setOtpValue(cleaned);
        if (otpValue().length === 6) otpForm?.requestSubmit();
        return;
      }
      input.value = cleaned.slice(-1);
      if (cleaned && otpDigits[index + 1]) otpDigits[index + 1].focus();
      if (otpValue().length === 6) otpForm?.requestSubmit();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && otpDigits[index - 1]) {
        otpDigits[index - 1].focus();
      }
    });
    input.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text") || "";
      if (!/\d/.test(text)) return;
      event.preventDefault();
      setOtpValue(text);
      if (otpValue().length === 6) otpForm?.requestSubmit();
    });
  });

  otpForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const code = otpValue();
    showError(otpError, "");
    if (!/^\d{6}$/.test(code)) {
      showError(otpError, "Enter the 6-digit code.");
      otpDigits[0]?.focus();
      return;
    }
    busy = true;
    if (verifyBtn) verifyBtn.disabled = true;
    setStatus("Verifying…");
    try {
      const verifyBody = { email: pendingEmail, code };
      if (orderIdHint) verifyBody.orderId = orderIdHint;
      const result = await postJson("/api/amare/auth/email/verify-code", verifyBody);
      if (!result.ok) {
        showError(otpError, "That code didn’t work. Try again or request a new one.");
        setStatus("");
        return;
      }
      setStatus("");
      await afterVerify(result.json || {});
    } catch {
      showError(otpError, "We could not verify that code. Please try again.");
      setStatus("");
    } finally {
      busy = false;
      if (verifyBtn) verifyBtn.disabled = false;
    }
  });

  resendBtn?.addEventListener("click", async () => {
    if (busy || !pendingEmail || resendBtn.disabled) return;
    busy = true;
    resendBtn.disabled = true;
    try {
      await requestCode(pendingEmail);
      startResendCountdown();
      setStatus("If a new code can be sent, it is on its way.");
    } catch {
      startResendCountdown();
    } finally {
      busy = false;
    }
  });

  document.getElementById("amare-login-use-different")?.addEventListener("click", () => {
    pendingEmail = "";
    setOtpValue("");
    showError(otpError, "");
    showStep("email");
    emailInput?.focus();
  });

  async function confirmClaim(continueAsNew) {
    if (busy) return;
    busy = true;
    if (claimConfirmBtn) claimConfirmBtn.disabled = true;
    if (claimNewBtn) claimNewBtn.disabled = true;
    showError(claimError, "");
    try {
      let result;
      if (claimMode === "pending_link") {
        result = await postJson("/api/amare/auth/association/link", { explicitPromote: true });
      } else {
        const body = continueAsNew ? { continueAsNew: true } : { explicitConfirm: true };
        result = await postJson("/api/amare/auth/claim/confirm", body);
      }
      if (!result.ok) {
        showError(claimError, "We could not confirm that profile. Please try again or sign in with a different method.");
        return;
      }
      const session = await getSession();
      if (session.signedIn) finishSignedIn();
      else showError(claimError, "We could not finish signing you in. Please try again.");
    } catch {
      showError(claimError, "We could not confirm that profile. Please try again.");
    } finally {
      busy = false;
      if (claimConfirmBtn) claimConfirmBtn.disabled = false;
      if (claimNewBtn) claimNewBtn.disabled = false;
    }
  }

  claimConfirmBtn?.addEventListener("click", () => confirmClaim(false));
  claimNewBtn?.addEventListener("click", () => confirmClaim(true));
  claimRejectBtn?.addEventListener("click", () => {
    showStep("claim_mismatch");
  });
  claimUseDifferentBtn?.addEventListener("click", () => {
    pendingEmail = "";
    setOtpValue("");
    showError(claimError, "");
    showStep("email");
    emailInput?.focus();
  });

  profileForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    showError(profileError, "");
    const firstName = String(firstNameInput?.value || "").trim();
    const lastName = String(lastNameInput?.value || "").trim();
    const mobilePhone = String(phoneInput?.value || "").trim();
    if (!firstName) {
      showError(profileError, "Enter your first name.", firstNameInput);
      firstNameInput?.focus();
      return;
    }
    if (!lastName) {
      showError(profileError, "Enter your last name.", lastNameInput);
      lastNameInput?.focus();
      return;
    }
    if (!mobilePhone) {
      showError(profileError, "Enter a valid US mobile phone number.", phoneInput);
      phoneInput?.focus();
      return;
    }
    busy = true;
    if (profileCreateBtn) profileCreateBtn.disabled = true;
    setStatus("Creating your profile…");
    try {
      await refreshProfileTx();
      const result = await postJson("/api/amare/auth/profile/create", {
        firstName,
        lastName,
        mobilePhone,
        explicitCreate: true,
      });
      if (result.ok && (result.json?.status === "linked" || result.json?.claimStatus === "linked")) {
        setStatus("");
        finishSignedIn();
        return;
      }
      const claim = result.json && result.json.claimStatus;
      if (claim === "candidate") {
        setStatus("");
        showClaim("candidate", lastMaskedEmail);
        return;
      }
      if (claim === "ambiguous" || claim === "conflict") {
        showError(profileError, "We could not connect this sign-in to a studio profile. Please contact the studio.");
        setStatus("");
        return;
      }
      if (claim === "search_unavailable" || result.status === 503) {
        showStep("unavailable");
        setStatus("");
        return;
      }
      if (result.json?.error === "first_name_required") {
        showError(profileError, "Enter your first name.", firstNameInput);
      } else if (result.json?.error === "last_name_required") {
        showError(profileError, "Enter your last name.", lastNameInput);
      } else if (result.json?.error === "mobile_phone_required") {
        showError(profileError, "Enter a valid US mobile phone number.", phoneInput);
      } else {
        showError(profileError, "We could not create your profile right now. Please try again.");
      }
      setStatus("");
    } catch {
      showError(profileError, "We could not create your profile right now. Please try again.");
      setStatus("");
    } finally {
      busy = false;
      if (profileCreateBtn) profileCreateBtn.disabled = false;
    }
  });

  unavailableRetryBtn?.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    if (unavailableRetryBtn) unavailableRetryBtn.disabled = true;
    try {
      const began = await postJson("/api/amare/auth/profile/begin", {});
      if (began.ok && began.json?.claimStatus === "needs_profile") {
        showStep("profile");
        return;
      }
      const claim = began.json && began.json.claimStatus;
      if (claim === "candidate") {
        showClaim("candidate", lastMaskedEmail);
        return;
      }
      const access = await getMemberAccess();
      if (access.studioAccess === "needs_profile") {
        showStep("profile");
        return;
      }
      if (access.studioAccess === "linked") {
        finishSignedIn();
        return;
      }
      showStep("unavailable");
    } catch {
      showStep("unavailable");
    } finally {
      busy = false;
      if (unavailableRetryBtn) unavailableRetryBtn.disabled = false;
    }
  });

  logoutBtn?.addEventListener("click", async () => {
    try {
      localStorage.removeItem("amare-header-auth");
      localStorage.removeItem("amare-mb-header");
    } catch {
      /* ignore */
    }
    await postJson("/api/amare/auth/logout", {});
    showStep("email");
    setStatus("You are signed out of AMARÉ.");
  });

  logoutAllBtn?.addEventListener("click", async () => {
    try {
      localStorage.removeItem("amare-header-auth");
      localStorage.removeItem("amare-mb-header");
    } catch {
      /* ignore */
    }
    await postJson("/api/amare/auth/logout/all", {});
    showStep("email");
    setStatus("You are signed out of all connected sessions.");
  });
})();
