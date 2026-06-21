import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiJson } from "../api/client";
import { BalancesSection } from "../components/profile/BalancesSection";
import { MembershipsSection } from "../components/profile/MembershipsSection";
import { ServicesPackagesSection } from "../components/profile/ServicesPackagesSection";
import { VisitHistorySection } from "../components/profile/VisitHistorySection";
import { ScheduleWallet } from "../components/schedule/ScheduleWallet";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import {
  clientField,
  profileDisplayName,
} from "../lib/member-profile-utils";
import {
  formatCacheAge,
  readMemberSummaryCache,
  writeMemberSummaryCache,
} from "../lib/member-summary-cache";
import { pricingUrl } from "../config";

export function ProfileScreen() {
  const { accessToken, isLoggedIn, profile, signIn, signOut, loading: authLoading, refreshProfile } =
    useAuth();
  const [summary, setSummary] = useState<unknown>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const pageRef = useRef<HTMLDivElement>(null);

  const loadSummary = useCallback(async (opts?: { silent?: boolean }) => {
    if (!accessToken) {
      setSummary(null);
      setCacheNote(null);
      return;
    }
    if (!opts?.silent) setWalletLoading(true);
    setError(null);
    try {
      const data = await apiJson<Record<string, unknown>>("/api/mindbody/member/summary", accessToken);
      setSummary(data);
      writeMemberSummaryCache(data);
      setCacheNote(null);
      const w = data.warnings;
      setWarnings(Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : []);
    } catch (e) {
      const cached = readMemberSummaryCache();
      if (cached) {
        setSummary(cached.data);
        setCacheNote(`Offline — showing saved data from ${formatCacheAge(cached.savedAt)}`);
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : "load_failed");
        setSummary(null);
      }
    } finally {
      if (!opts?.silent) setWalletLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    const cached = readMemberSummaryCache();
    if (cached) {
      setSummary(cached.data);
      setCacheNote(`Showing saved data from ${formatCacheAge(cached.savedAt)}…`);
    }
    void loadSummary();
  }, [accessToken, loadSummary]);

  const handleRefresh = useCallback(async () => {
    await refreshProfile();
    await loadSummary();
  }, [refreshProfile, loadSummary]);

  const { pulling, refreshing } = usePullToRefresh(pageRef, {
    onRefresh: handleRefresh,
    enabled: isLoggedIn,
  });

  if (!isLoggedIn) {
    return (
      <div className="gate">
        <p>Sign in to view your membership and credits.</p>
        <button type="button" className="btn" onClick={signIn}>
          Sign in with Mindbody
        </button>
      </div>
    );
  }

  if (authLoading && !summary) return <div className="spinner">Loading…</div>;

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
        <div className="profile-page__ptr" aria-live="polite">
          {refreshing ? "Refreshing…" : "Pull to refresh"}
        </div>
      )}

      <h1 className="schedule-page__title">Profile</h1>

      {cacheNote && <div className="wallet-banner">{cacheNote}</div>}
      {error && <div className="error-banner">{error}</div>}
      {clientUnlinked && (
        <div className="wallet-banner wallet-banner--warn">
          We couldn&apos;t match your login to a Mindbody client record. Use the same email as in
          Mindbody, or ask the desk to verify your account.
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
          <dt>Client ID</dt>
          <dd>{profile?.clientId ?? sum?.clientId ?? "—"}</dd>
        </dl>
        <p className="card__meta profile-page__hint">
          Upcoming classes are in <Link to="/my-classes">My Classes</Link>.
        </p>
      </div>

      {!clientUnlinked && summary ? (
        <>
          <VisitHistorySection summary={summary} />
          <ServicesPackagesSection summary={summary} />
          <MembershipsSection summary={summary} />
          <BalancesSection summary={summary} />
        </>
      ) : null}

      <button
        type="button"
        className="btn btn--ghost profile-page__refresh"
        disabled={walletLoading || refreshing}
        onClick={() => void handleRefresh()}
      >
        {walletLoading || refreshing ? "Refreshing…" : "Refresh from Mindbody"}
      </button>

      <a
        className="btn"
        href={pricingUrl()}
        target="_blank"
        rel="noopener noreferrer"
        style={{ width: "100%", marginBottom: "0.75rem" }}
      >
        Buy a pass
      </a>
      <button type="button" className="btn btn--ghost" style={{ width: "100%" }} onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
