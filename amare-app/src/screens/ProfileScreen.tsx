import { useCallback, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AppHero } from "../components/AppHero";
import { BenefitsSection } from "../components/profile/BenefitsSection";
import { MembershipsSection } from "../components/profile/MembershipsSection";
import { NotificationsSection } from "../components/profile/NotificationsSection";
import { ServicesPackagesSection } from "../components/profile/ServicesPackagesSection";
import { ScheduleWallet } from "../components/schedule/ScheduleWallet";
import { MemberTopUpCard } from "../components/MemberTopUpCard";
import { SignedOutGate } from "../components/SignedOutGate";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { clientField, profileDisplayName } from "../lib/member-profile-utils";
import { sitePageUrl } from "../config";
import { PRIVATE_EVENTS_URL, openExternalUrl } from "../lib/studio-contact";

export function ProfileScreen() {
  const { isLoggedIn, profile, accessToken, signIn, signOut, loading: authLoading, refreshProfile } =
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
      <div className="profile-page">
        <AppHero />
      <SignedOutGate title="Your account" lede="Sign in to see membership, credits, and studio support.">
        <div className="profile-links">
          <Link to="/purchase">Memberships</Link>
          <button type="button" className="profile-links__btn" onClick={() => void openExternalUrl(PRIVATE_EVENTS_URL)}>
            Host an event
          </button>
          <Link to="/contact">Contact</Link>
          <a href={sitePageUrl("/privacy")} target="_blank" rel="noopener noreferrer">
            Privacy
          </a>
          <a href={sitePageUrl("/terms")} target="_blank" rel="noopener noreferrer">
            Terms
          </a>
        </div>
      </SignedOutGate>
      </div>
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
      <AppHero />
      {bootstrapping ? (
        <div className="spinner">Loading…</div>
      ) : (
        <>
      <h2 className="schedule-page__title">Profile</h2>

      {cacheNote && <div className="wallet-banner">{cacheNote}</div>}
      {error && <div className="error-banner">{error}</div>}
      {(clientUnlinked || incompleteAccess) && (
        <div className="wallet-banner wallet-banner--warn">
          {profile?.studioAccess === "candidate"
            ? "We found your existing AMARÉ profile. Confirm it to access purchases, credits, and bookings."
            : profile?.studioAccess === "needs_profile"
              ? "Finish setting up your AMARÉ profile."
              : profile?.studioAccess === "conflict"
                ? "This account cannot book or purchase online until the studio reviews it."
                : profile?.studioAccess === "ambiguous"
                  ? "More than one studio profile matches this sign-in. Contact AMARÉ — we will not guess."
                  : "Your AMARÉ sign-in is not connected to a studio profile yet. Finish connecting, or ask the desk to help."}
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
      {accessToken ? <MemberTopUpCard accessToken={accessToken} /> : null}

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

      {!clientUnlinked && accessToken ? <BenefitsSection accessToken={accessToken} /> : null}

      {!clientUnlinked && summary ? (
        <>
          <ServicesPackagesSection summary={summary} />
          <MembershipsSection summary={summary} />
        </>
      ) : null}

      <button
        type="button"
        className="home-directions profile-event"
        onClick={() => void openExternalUrl(PRIVATE_EVENTS_URL)}
      >
        <strong>Host an event</strong>
        <span>Bridal showers, workshops, and private celebrations at the studio.</span>
      </button>

      <section className="card profile-section">
        <h2>Support</h2>
        <div className="profile-links profile-links--in-card">
          <Link to="/contact">Contact the studio</Link>
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
