import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiJson, buildScheduleClassMap, staffName } from "../api/client";
import { AppHero } from "../components/AppHero";
import { MemberTopUpCard } from "../components/MemberTopUpCard";
import { StudioImageCarousel } from "../components/StudioImageCarousel";
import { HomeCardsSkeleton } from "../components/LoadingSkeletons";
import { useBringAFriendStatus } from "../components/bring-a-friend/BringAFriendSection";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import {
  creditsMeter,
  monthMotivation,
  nextUpcomingVisit,
  planLabel,
  planRenewalLine,
  waitlistCount,
} from "../lib/home-stats";
import {
  PARKING_MAP_ALT,
  PARKING_MAP_URL,
  STUDIO_ADDRESS_LINE,
  openStudioDirections,
} from "../lib/studio-maps";
import {
  classShapeForVisit,
  formatVisitWhen,
  scheduleQueryParamsForVisits,
  visitClassId,
  visitName,
  visitStartIso,
  visitStaffLabel,
} from "../lib/visit-utils";

function StudioDirectionsButton() {
  return (
    <button type="button" className="home-directions" onClick={() => void openStudioDirections()}>
      <strong>Get directions</strong>
      <span>{STUDIO_ADDRESS_LINE}</span>
    </button>
  );
}

function ParkingCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="home-directions" onClick={onOpen}>
      <strong>Parking</strong>
      <span>Free street spots by the entrance, plus a free garage in the building.</span>
    </button>
  );
}

function ParkingMapDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card home-parking-modal"
        role="dialog"
        aria-labelledby="home-parking-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="home-parking-title">Parking</h2>
        <img src={PARKING_MAP_URL} alt={PARKING_MAP_ALT} width={1600} height={1289} />
        <p className="card__meta">
          Green is free. Red is paid — use the street spots by the entrance or the free garage in the
          building.
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--cream" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function HomeRing({ value, max, children }: { value: number; max: number; children: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = max <= 0 ? 0 : Math.min(1, value / max);
  const dash = c * pct;
  return (
    <div className="home-ring__dial">
      <svg className="home-ring__svg" viewBox="0 0 80 80" aria-hidden="true">
        <circle className="home-ring__track" cx="40" cy="40" r={r} />
        <circle className="home-ring__fill" cx="40" cy="40" r={r} strokeDasharray={`${dash} ${c - dash}`} />
      </svg>
      <span className="home-ring__value">{children}</span>
    </div>
  );
}

export function HomeScreen() {
  const { isLoggedIn, signIn, accessToken, refreshProfile } = useAuth();
  const { summary, loading, initialReady, error, reload } = useMemberSummary();
  const showSkeleton = isLoggedIn && !summary && !error && (!initialReady || loading);
  const { status: bafStatus, reload: reloadBaf } = useBringAFriendStatus(isLoggedIn ? accessToken : null);
  const showPerks = bafStatus?.eligible === true;
  const pageRef = useRef<HTMLDivElement>(null);
  const [parkingOpen, setParkingOpen] = useState(false);
  const [scheduleByClassId, setScheduleByClassId] = useState<Map<number, Record<string, unknown>>>(
    () => new Map(),
  );
  const next = useMemo(() => nextUpcomingVisit(summary), [summary]);
  const nextKey = next ? `${visitClassId(next) ?? ""}-${visitStartIso(next)}` : "";

  useEffect(() => {
    if (!isLoggedIn || !next) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiJson<unknown>(
          `/api/mindbody/class/classes?${scheduleQueryParamsForVisits([next])}`,
          null,
        );
        if (!cancelled) setScheduleByClassId(buildScheduleClassMap(data));
      } catch {
        /* visit fallback still shows */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, next, nextKey]);

  const handleRefresh = useCallback(async () => {
    await refreshProfile();
    await reload();
    await reloadBaf();
  }, [refreshProfile, reload, reloadBaf]);

  const { pulling, refreshing } = usePullToRefresh(pageRef, {
    onRefresh: handleRefresh,
    enabled: isLoggedIn,
  });

  if (!isLoggedIn) {
    return (
      <div className="home-page">
        <AppHero />
        <StudioImageCarousel />
        <p className="home-page__sub">Boutique Reformer, Mat, and movement in Hallandale.</p>
        <div className="home-page__actions">
          <button type="button" className="btn" onClick={signIn}>
            Sign in
          </button>
          <Link className="btn btn--ghost" to="/schedule">
            Browse schedule
          </Link>
        </div>
        <div className="home-teasers">
          <Link className="home-teaser" to="/schedule">
            <strong>Class types</strong>
            <span>Reformer, Mat, and more — see what’s on this week.</span>
          </Link>
          <Link className="home-teaser" to="/purchase">
            <strong>Memberships</strong>
            <span>Packages and plans for your rhythm.</span>
          </Link>
          <StudioDirectionsButton />
          <ParkingCard onOpen={() => setParkingOpen(true)} />
          <Link className="home-directions" to="/first-visit">
            <strong>First visit</strong>
            <span>Arrive early, what to bring, and how class works.</span>
          </Link>
        </div>
        <ParkingMapDialog open={parkingOpen} onClose={() => setParkingOpen(false)} />
      </div>
    );
  }

  const waitlists = waitlistCount(summary);
  const credits = creditsMeter(summary);
  const motivation = monthMotivation(summary);
  const renewal = planRenewalLine(summary);
  const nextWhen = next ? formatVisitWhen(next) : "—";
  const nextInstructor = next
    ? (() => {
        const fromSchedule = staffName(classShapeForVisit(next, scheduleByClassId));
        return fromSchedule && fromSchedule !== "—" ? fromSchedule : visitStaffLabel(next);
      })()
    : "";
  const ringValue =
    loading && !summary
      ? "…"
      : credits.mode === "unlimited"
        ? "∞"
        : credits.mode === "empty"
          ? "—"
          : String(credits.remaining);
  const ringCaption =
    credits.mode === "unlimited" ? "Unlimited" : credits.mode === "empty" ? "No pack yet" : credits.remaining === 1 ? "visit left" : "visits left";

  return (
    <div className="home-page" ref={pageRef}>
      {(pulling || refreshing) && (
        <div className="page-ptr" aria-live="polite">
          {refreshing ? "Refreshing…" : "Pull to refresh"}
        </div>
      )}
      <AppHero />

      {error && <div className="error-banner">{error}</div>}

      {showSkeleton ? (
        <HomeCardsSkeleton />
      ) : (
        <>
      <div className="home-meter" aria-busy={loading && !summary}>
        <HomeRing
          value={credits.mode === "unlimited" ? 1 : credits.remaining}
          max={credits.mode === "unlimited" ? 1 : credits.total}
        >
          {ringValue}
        </HomeRing>
        <div className="home-meter__copy">
          <p className="home-meter__caption">{ringCaption}</p>
          <p className="home-meter__note">{motivation}</p>
        </div>
      </div>

      {accessToken ? <MemberTopUpCard accessToken={accessToken} compact /> : null}

      {next ? (
        <Link className="card home-next" to="/my-classes?section=upcoming">
          <div className="home-next__copy">
            <h2>Your next class</h2>
            <p className="home-next__when">{nextWhen}</p>
            <p className="home-next__name">{visitName(next)}</p>
            {nextInstructor ? <p className="card__meta">{nextInstructor}</p> : null}
          </div>
          <span className="home-next__go" aria-hidden="true">View</span>
        </Link>
      ) : waitlists > 0 ? (
        <Link className="card home-next" to="/my-classes?section=waitlist">
          <div className="home-next__copy">
            <h2>Waitlist</h2>
            <p className="card__meta">
              You’re on {waitlists} waitlist{waitlists === 1 ? "" : "s"}. We’ll email you if a spot opens.
            </p>
          </div>
          <span className="home-next__go" aria-hidden="true">View</span>
        </Link>
      ) : credits.mode === "empty" ? (
        <Link className="card home-next" to="/purchase">
          <div className="home-next__copy">
            <h2>Ready when you are</h2>
            <p className="card__meta">Add a pass and your next class is waiting.</p>
          </div>
          <span className="home-next__go" aria-hidden="true">Buy</span>
        </Link>
      ) : (
        <Link className="card home-next" to="/schedule">
          <div className="home-next__copy">
            <h2>You’re all set</h2>
            <p className="card__meta">Book your next class when you’re ready.</p>
          </div>
          <span className="home-next__go" aria-hidden="true">Book</span>
        </Link>
      )}

      <div className="home-page__actions">
        <Link className="btn btn--cream" to="/schedule">
          Book a class
        </Link>
        <div className="home-page__actions-row">
          <Link className="btn btn--ghost" to="/my-classes?section=upcoming">
            My classes
          </Link>
          <Link className="btn btn--ghost" to="/purchase">
            Buy a pass
          </Link>
        </div>
        {showPerks ? (
          <Link className="home-perk-link" to="/my-classes?section=upcoming">
            Bring a friend
          </Link>
        ) : null}
      </div>

      <div className="home-visit">
        <StudioDirectionsButton />
        <ParkingCard onOpen={() => setParkingOpen(true)} />
      </div>
      <ParkingMapDialog open={parkingOpen} onClose={() => setParkingOpen(false)} />

      <section className="card home-plan">
        <p className="home-plan__label">Plan</p>
        <h2>{planLabel(summary)}</h2>
        {renewal ? <p className="card__meta">{renewal}</p> : null}
      </section>

      <Link className="home-directions" to="/first-visit">
        <strong>First visit</strong>
        <span>Arrive early, what to bring, and how class works.</span>
      </Link>
        </>
      )}
    </div>
  );
}
