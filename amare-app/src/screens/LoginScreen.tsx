import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  beginProfileTx,
  confirmCandidateProfile,
  createStudioProfile,
  requestEmailOtp,
  sanitizeOrderIdHint,
  verifyEmailOtp,
} from "../api/amare-auth";
import { StudioImageCarousel } from "../components/StudioImageCarousel";
import { currentProfileTxToken, safeAppReturnPath, saveProfileTxToken } from "../config";

type Step =
  | "email"
  | "otp"
  | "candidate"
  | "mismatch"
  | "needs_profile"
  | "ambiguous"
  | "conflict"
  | "unavailable";

function applyVerifyStatus(status: string | undefined): Step | "linked" {
  switch (status) {
    case "linked":
    case "verified":
      return "linked";
    case "candidate":
      return "candidate";
    case "needs_profile":
      return "needs_profile";
    case "ambiguous":
      return "ambiguous";
    case "conflict":
      return "conflict";
    default:
      return "unavailable";
  }
}

export function LoginScreen() {
  const { accessToken, applyAmareTokens, signOut, refreshProfile, isLoggedIn, profile } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const accountDeleted = params.get("deleted") === "1";
  const returnPath = useMemo(() => safeAppReturnPath(params.get("return") || params.get("next")), [params]);
  const orderIdHint = useMemo(() => sanitizeOrderIdHint(params.get("order")), [params]);
  const presetEmail = String(params.get("email") || "").trim();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(presetEmail);
  const [code, setCode] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [mobilePhone, setMobilePhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isLoggedIn || !profile?.studioAccess) return;
    if (profile.studioAccess === "linked" || profile.studioAccess === "verified") {
      navigate(returnPath, { replace: true });
      return;
    }
    if (profile.studioAccess === "candidate") setStep("candidate");
    else if (profile.studioAccess === "needs_profile") setStep("needs_profile");
    else if (profile.studioAccess === "ambiguous") setStep("ambiguous");
    else if (profile.studioAccess === "conflict") setStep("conflict");
  }, [isLoggedIn, profile?.studioAccess, navigate, returnPath]);

  async function finishLinked(nextAccess?: string, nextRefresh?: string) {
    if (nextAccess && nextRefresh) await applyAmareTokens(nextAccess, nextRefresh);
    else await refreshProfile({ showLoading: true });
    navigate(returnPath, { replace: true });
  }

  async function onRequestCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestEmailOtp(email);
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error && err.message === "invalid_email" ? "Enter a valid email." : "Could not send a code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await verifyEmailOtp(email, code, orderIdHint);
      if (data.maskedEmail) setMaskedEmail(data.maskedEmail);
      if (data.purchaseConnected && (data.claimStatus === "linked" || data.claimStatus === "verified")) {
        await finishLinked(data.accessToken, data.refreshToken);
        return;
      }
      const next = applyVerifyStatus(data.claimStatus || data.status);
      if (next === "linked") {
        await finishLinked(data.accessToken, data.refreshToken);
        return;
      }
      if (data.accessToken && data.refreshToken) await applyAmareTokens(data.accessToken, data.refreshToken);
      if (next === "needs_profile" && !data.profileTxToken) {
        try {
          const begun = await beginProfileTx(data.accessToken || accessToken || "");
          if (begun.profileTxToken) saveProfileTxToken(begun.profileTxToken);
        } catch {
          /* create can still try cookie-less begin later */
        }
      }
      setStep(next);
    } catch {
      setError("That code didn’t work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmCandidate() {
    setError(null);
    setBusy(true);
    try {
      const token = accessToken;
      if (!token) throw new Error("signed_out");
      const data = await confirmCandidateProfile(token);
      if (data.status === "linked" || data.status === "verified" || data.ok) {
        await finishLinked(data.accessToken, data.refreshToken);
        return;
      }
      if (data.accessToken && data.refreshToken) await applyAmareTokens(data.accessToken, data.refreshToken);
      setError("Could not confirm this profile.");
    } catch {
      setError("Could not confirm this profile. Try signing in again.");
    } finally {
      setBusy(false);
    }
  }

  function onRejectCandidate() {
    setStep("mismatch");
  }

  async function onCreateProfile(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const token = accessToken;
      if (!token) throw new Error("signed_out");
      const data = await createStudioProfile(token, {
        firstName,
        lastName,
        mobilePhone,
        profileTx: currentProfileTxToken(),
      });
      if (data.ok && (data.claimStatus === "linked" || data.status === "linked")) {
        saveProfileTxToken(null);
        await finishLinked(data.accessToken, data.refreshToken);
        return;
      }
      if (data.accessToken && data.refreshToken) await applyAmareTokens(data.accessToken, data.refreshToken);
      setError("Could not create your profile. Try again.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "missing_profile_tx") {
        try {
          const begun = await beginProfileTx(accessToken || "");
          if (begun.profileTxToken) saveProfileTxToken(begun.profileTxToken);
          setError("Please tap Create my profile again.");
        } catch {
          setError("Could not create your profile. Try again.");
        }
      } else {
        setError("Could not create your profile. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function resetToEmail() {
    setCode("");
    setError(null);
    setStep("email");
    if (isLoggedIn) await signOut();
  }

  return (
    <div className="amare-login">
      {accountDeleted && step === "email" ? (
        <div className="wallet-banner account-deletion__success" role="status">
          Your AMARÉ app account was deleted and you were signed out. Studio billing and bookings were not cancelled.
        </div>
      ) : null}
      {step === "email" ? <StudioImageCarousel /> : null}
      {step === "email" && (
        <>
          <h1 className="amare-login__title">Welcome to AMARÉ</h1>
          <p className="amare-login__lede">
            Boutique Reformer, Mat, and studio classes in Hallandale. We’ll email you a one-time code to
            sign in.
          </p>
          <form className="amare-login__form" onSubmit={(e) => void onRequestCode(e)}>
            <label htmlFor="amare-app-email">Email</label>
            <input
              id="amare-app-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {error && <p className="amare-login__error">{error}</p>}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Continue"}
            </button>
          </form>
        </>
      )}

      {step === "otp" && (
        <>
          <h1 className="amare-login__title">Enter your code</h1>
          <p className="amare-login__lede">We sent a one-time code to {email}.</p>
          <form className="amare-login__form" onSubmit={(e) => void onVerify(e)}>
            <label htmlFor="amare-app-otp">Code</label>
            <input
              id="amare-app-otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              required
            />
            {error && <p className="amare-login__error">{error}</p>}
            <button className="btn" type="submit" disabled={busy || code.length < 4}>
              {busy ? "Checking…" : "Verify"}
            </button>
            <button className="amare-login__text-btn" type="button" onClick={() => void resetToEmail()}>
              Use a different email
            </button>
          </form>
        </>
      )}

      {step === "candidate" && (
        <>
          <h1 className="amare-login__title">We found your existing AMARÉ profile</h1>
          <p className="amare-login__lede">
            We found a studio profile connected to{" "}
            <strong>{maskedEmail || profile?.email || "your email"}</strong>. Confirm this is your profile to
            access your existing purchases, credits, and bookings.
          </p>
          {error && <p className="amare-login__error">{error}</p>}
          <div className="amare-login__actions">
            <button className="btn" type="button" disabled={busy} onClick={() => void onConfirmCandidate()}>
              Continue with this profile
            </button>
            <button className="btn btn--ghost" type="button" disabled={busy} onClick={onRejectCandidate}>
              This isn&apos;t my profile
            </button>
          </div>
        </>
      )}

      {step === "mismatch" && (
        <>
          <h1 className="amare-login__title">This isn&apos;t my profile</h1>
          <p className="amare-login__lede">
            We did not create a new studio profile. Sign in with a different email, or contact the studio if this
            looks wrong.
          </p>
          <div className="amare-login__actions">
            <button className="btn" type="button" onClick={() => void resetToEmail()}>
              Use a different email
            </button>
            <Link className="btn btn--ghost" to="/contact">
              Contact AMARÉ
            </Link>
          </div>
        </>
      )}

      {step === "needs_profile" && (
        <>
          <h1 className="amare-login__title">Welcome to AMARÉ</h1>
          <p className="amare-login__lede">Let’s finish setting up your profile.</p>
          <form className="amare-login__form" onSubmit={(e) => void onCreateProfile(e)}>
            <label htmlFor="amare-app-first">First name</label>
            <input
              id="amare-app-first"
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
            <label htmlFor="amare-app-last">Last name</label>
            <input
              id="amare-app-last"
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
            <label htmlFor="amare-app-phone">Mobile phone</label>
            <input
              id="amare-app-phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={mobilePhone}
              onChange={(e) => setMobilePhone(e.target.value)}
              required
            />
            {error && <p className="amare-login__error">{error}</p>}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create my profile"}
            </button>
          </form>
        </>
      )}

      {step === "ambiguous" && (
        <>
          <h1 className="amare-login__title">We need a little help</h1>
          <p className="amare-login__lede">
            More than one studio profile matches this email. Contact AMARÉ so we can connect the correct one. We
            will not guess.
          </p>
          <button className="btn" type="button" onClick={() => void resetToEmail()}>
            Use a different email
          </button>
        </>
      )}

      {step === "conflict" && (
        <>
          <h1 className="amare-login__title">This account needs the studio</h1>
          <p className="amare-login__lede">
            Online booking and purchases are paused for this sign-in until AMARÉ can review it. You are not a guest.
          </p>
          <button className="btn" type="button" onClick={() => void resetToEmail()}>
            Use a different email
          </button>
        </>
      )}

      {step === "unavailable" && (
        <>
          <h1 className="amare-login__title">Please try again</h1>
          <p className="amare-login__lede">We couldn’t finish checking your studio profile right now.</p>
          <button className="btn" type="button" onClick={() => void resetToEmail()}>
            Try again
          </button>
        </>
      )}

      <p className="amare-login__hint">
        <Link to={returnPath}>Back</Link>
      </p>
    </div>
  );
}
