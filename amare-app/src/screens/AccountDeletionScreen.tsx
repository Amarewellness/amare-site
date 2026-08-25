import { FormEvent, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { deleteAmareAccount, requestEmailOtp } from "../api/amare-auth";
import { useAuth } from "../auth/AuthContext";

type Step = "intro" | "otp";

function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > 2 ? "•••" : ""}@${domain}`;
}

function deleteErrorMessage(code: string): string {
  switch (code) {
    case "invalid_code":
      return "That code didn’t work. Try again.";
    case "email_mismatch":
      return "This email doesn’t match your AMARÉ sign-in.";
    case "not_authenticated":
      return "Your session expired. Sign in again to continue.";
    case "confirm_required":
      return "Confirmation is required.";
    default:
      return "Could not delete your account. Try again or contact the studio.";
  }
}

export function AccountDeletionScreen() {
  const { isLoggedIn, accessToken, profile, clearLocalSession } = useAuth();
  const navigate = useNavigate();
  const email = useMemo(() => String(profile?.email || "").trim().toLowerCase(), [profile?.email]);
  const maskedEmail = useMemo(() => (email ? maskEmail(email) : ""), [email]);

  const [step, setStep] = useState<Step>("intro");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isLoggedIn) {
    return <Navigate to="/profile" replace />;
  }

  if (!email) {
    return (
      <div className="profile-page account-deletion">
        <Link to="/profile" className="account-deletion__back">
          ← Profile
        </Link>
        <h2 className="schedule-page__title">Delete AMARÉ app account</h2>
        <div className="wallet-banner wallet-banner--warn">
          We couldn&apos;t find an email for this sign-in. Contact the studio for help deleting your app account.
        </div>
        <Link className="btn btn--ghost" to="/contact" style={{ width: "100%" }}>
          Contact the studio
        </Link>
      </div>
    );
  }

  async function onSendCode() {
    setError(null);
    setBusy(true);
    try {
      await requestEmailOtp(email);
      setStep("otp");
    } catch {
      setError("Could not send a verification code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmDelete(e: FormEvent) {
    e.preventDefault();
    if (!accessToken) {
      setError(deleteErrorMessage("not_authenticated"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await deleteAmareAccount(accessToken, { email, code });
      await clearLocalSession();
      navigate("/login?deleted=1", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "account_delete_failed";
      setError(deleteErrorMessage(msg));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="profile-page account-deletion">
      <Link to="/profile" className="account-deletion__back">
        ← Profile
      </Link>

      {step === "intro" && (
        <>
          <h2 className="schedule-page__title">Delete your AMARÉ app account?</h2>
          <div className="card profile-section account-deletion__card">
            <p>
              This removes your AMARÉ app sign-in, signs you out, stops app notifications, and removes app access
              tied to this account.
            </p>
            <p className="account-deletion__important">
              <strong>Important:</strong> This does not cancel memberships, billing, credits, or bookings. Contact the
              studio for billing or schedule changes.
            </p>
            {error && <p className="amare-login__error">{error}</p>}
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void onSendCode()}>
              {busy ? "Sending…" : "Send verification code"}
            </button>
          </div>
        </>
      )}

      {step === "otp" && (
        <>
          <h2 className="schedule-page__title">Confirm deletion</h2>
          <p className="account-deletion__lede">
            For your security, enter the one-time code we sent to <strong>{maskedEmail}</strong>.
          </p>
          <form className="amare-login__form account-deletion__form" onSubmit={(e) => void onConfirmDelete(e)}>
            <label htmlFor="amare-delete-otp">Code</label>
            <input
              id="amare-delete-otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              required
            />
            {error && <p className="amare-login__error">{error}</p>}
            <button className="btn account-deletion__confirm" type="submit" disabled={busy || code.length < 4}>
              {busy ? "Deleting…" : "Delete AMARÉ app account"}
            </button>
            <button
              type="button"
              className="amare-login__text-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setCode("");
                void onSendCode();
              }}
            >
              Resend code
            </button>
            <button
              type="button"
              className="amare-login__text-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setCode("");
                setStep("intro");
              }}
            >
              Back
            </button>
          </form>
        </>
      )}
    </div>
  );
}
