import { useCallback, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { BalancesSection } from "../components/profile/BalancesSection";
import { MembershipsSection } from "../components/profile/MembershipsSection";
import { NotificationsSection } from "../components/profile/NotificationsSection";
import { ServicesPackagesSection } from "../components/profile/ServicesPackagesSection";
import { ScheduleWallet } from "../components/schedule/ScheduleWallet";
import { SignedOutGate } from "../components/SignedOutGate";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { clientField, profileDisplayName } from "../lib/member-profile-utils";
import { apiBase, sitePageUrl } from "../config";
import { contactStudioUrl } from "../lib/booking-link";

export function ProfileScreen() {
  const { isLoggedIn, profile, signIn, signOut, loading: authLoading, refreshProfile } =
    useAuth();
  const { summary, loading: walletLoading, error, cacheNote, reload } = useMemberSummary();
  const incompleteAccess =
    profile?.studioAccess === "candidate" ||
    profile?.studioAccess === "needs_profile" ||
    profile?.studioAccess === "ambiguous" ||
    profile?.studioAccess === "conflict";
  const pageRef = useRef<HTMLDivElement>(null);

  const handleRefresh = useCallback(async () => {
    await refreshProfile();
    await reload();
  }, [refreshProfile, reload]);

  const { pulling, refreshing } = usePullToRefresh(pageRef, {
    onRefresh: handleRefresh,
    enabled: isLoggedIn,
  });

  const warnings = useMemo(() => {
    if (!summary || typeof summary !== "object") return [];
    const w = (summary as { warnings?: unknown }).warnings;
    return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : [];
  }, [summary]);

  if (!isLoggedIn) {
    return (
      <SignedOutGate title="Your account" lede="Sign in to see membership, credits, and studio support.">
        <div className="profile-links">
          <Link to="/purchase">Memberships</Link>
          <a href={contactStudioUrl(apiBase())} target="_blank" rel="noopener noreferrer">
            Contact
          </a>
          <a href={sitePageUrl("/privacy")} target="_blank" rel="noopener noreferrer">
            Privacy
          </a>
          <a href={sitePageUrl("/terms")} target="_blank" rel="noopener noreferrer">
            Terms
          </a>
        </div>
      </SignedOutGate>
    );
  }

  const bootstrapping = authLoading && !summary;

  const sum = summary as {
    clientId?: number | null;
    profile?: { sessionEmail?: string; sessionName?: string; client?: Record<string, unknown> };
  } | null;
  const client = sum?.profile?.client;
  const mobile = clientField(client, ["MobilePhone", "HomePhone", "Phone", "phone"]);
  const clientUnlinked = sum && sum.clientId == null;

  return (
    <div className="profile-page" ref={pageRef}>
      {(pulling || refreshing) && (
        <div className="page-ptr" aria-live="polite">
          {refreshing ? "Refreshing…" : "Pull to refresh"}
        </div>
      )}

      {bootstrapping ? (
        <div className="spinner">Loading…</div>
      ) : (
        <>
      <h1 className="schedule-page__title">Profile</h1>

      {cacheNote && <div className="wallet-banner">{cacheNote}</div>}
      {error && <div className="error-banner">{error}</div>}
      {(clientUnlinked || incompleteAccess) && (
        <div className="wallet-banner wallet-banner--warn">
          {profile?.studioAccess === "candidate"
            ? "We found your existing AMARÉ profile. Confirm it to access purchases, credits, and bookings."
            : profile?.studioAccess === "needs_profile"
              ? "Finish setting up your AMARÉ profile. No Mindbody password is required."
              : profile?.studioAccess === "conflict"
                ? "This account cannot book or purchase online until the studio reviews it."
                : profile?.studioAccess === "ambiguous"
                  ? "More than one studio profile matches this sign-in. Contact AMARÉ — we will not guess."
                  : "Your AMARÉ sign-in is not connected to a studio profile yet. Finish connecting, or ask the desk to help. No Mindbody password is required."}
          {incompleteAccess ? (
            <>
              {" "}
              <button type="button" className="amare-login__text-btn" onClick={signIn}>
                Continue
              </button>
            </>
          ) : null}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="wallet-banner wallet-banner--warn">
          Some account sections may be incomplete ({warnings.join(", ")}).
        </div>
      )}

      <ScheduleWallet summary={summary} loading={walletLoading && !summary} />

      <div className="card profile-section">
        <h2>Account</h2>
        <dl className="profile-dl">
          <dt>Name</dt>
          <dd>{profileDisplayName(client, profile?.name ?? sum?.profile?.sessionName)}</dd>
          <dt>Email</dt>
          <dd>
            {clientField(client, ["Email", "email"]) ||
              profile?.email ||
              sum?.profile?.sessionEmail ||
              "—"}
          </dd>
          {mobile ? (
            <>
              <dt>Mobile</dt>
              <dd>{mobile}</dd>
            </>
          ) : null}
        </dl>
        <p className="card__meta profile-page__hint">
          Upcoming classes are in <Link to="/my-classes?section=upcoming">My Classes</Link>.
        </p>
      </div>

      <NotificationsSection />

      {!clientUnlinked && summary ? (
        <>
          <ServicesPackagesSection summary={summary} />
          <MembershipsSection summary={summary} />
          <BalancesSection summary={summary} />
        </>
      ) : null}

      <section className="card profile-section">
        <h2>Support</h2>
        <div className="profile-links profile-links--in-card">
          <a href={contactStudioUrl(apiBase())} target="_blank" rel="noopener noreferrer">
            Contact the studio
          </a>
          <a href={sitePageUrl("/privacy")} target="_blank" rel="noopener noreferrer">
            Privacy
          </a>
          <a href={sitePageUrl("/terms")} target="_blank" rel="noopener noreferrer">
            Terms
          </a>
        </div>
      </section>

      <button
        type="button"
        className="btn btn--ghost profile-page__refresh"
        disabled={walletLoading || refreshing}
        onClick={() => void handleRefresh()}
      >
        {walletLoading || refreshing ? "Refreshing…" : "Refresh"}
      </button>

      <Link className="btn" to="/purchase" style={{ width: "100%", marginBottom: "0.75rem" }}>
        Buy a pass
      </Link>
      <button type="button" className="btn btn--ghost" style={{ width: "100%" }} onClick={() => void signOut()}>
        Sign out
      </button>
        </>
      )}
    </div>
  );
}
