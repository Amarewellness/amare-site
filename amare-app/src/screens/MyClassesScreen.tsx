import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiJson, buildScheduleClassMap, scheduleQueryParams } from "../api/client";
import { cancelBooking, type CancelBookingOptions } from "../api/cancel-api";
import {
  BringAFriendSection,
  useBringAFriendStatus,
} from "../components/bring-a-friend/BringAFriendSection";
import { CancelClassDialog } from "../components/CancelClassDialog";
import { MyClassVisitCard } from "../components/my-classes/MyClassVisitCard";
import { PastVisitCard } from "../components/my-classes/PastVisitCard";
import { WaitlistClassCard } from "../components/my-classes/WaitlistClassCard";
import { SignedOutGate } from "../components/SignedOutGate";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { isClassEligibleForGuestInvite } from "../lib/bring-a-friend";
import { buildWaitlistEntryMap } from "../lib/member-summary";
import {
  classShapeForVisit,
  completedVisitsFromSummary,
  scheduleQueryParamsForVisits,
  upcomingVisitsFromSummary,
  upcomingWaitlistVisitsFromSummary,
  visitClassId,
  visitRowId,
  visitRowKey,
  type VisitRow,
} from "../lib/visit-utils";

type EnrichedVisit = {
  visit: VisitRow;
  cls: Record<string, unknown>;
};

type WaitlistItem = {
  classId: number;
  entryId: number;
  cls: Record<string, unknown> | null;
  visit: VisitRow | null;
};

const MY_CLASS_SECTIONS = ["upcoming", "waitlist", "past"] as const;
type MyClassSection = (typeof MY_CLASS_SECTIONS)[number];

function parseMyClassSection(raw: string | null): MyClassSection {
  if (raw === "waitlist" || raw === "past" || raw === "upcoming") return raw;
  return "upcoming";
}

export function MyClassesScreen() {
  const { accessToken, isLoggedIn, refreshProfile } = useAuth();
  const { summary, loading: summaryLoading, error: summaryError, reload: reloadSummary } =
    useMemberSummary();
  const [scheduleByClassId, setScheduleByClassId] = useState<Map<number, Record<string, unknown>>>(
    () => new Map(),
  );
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [pendingCancel, setPendingCancel] = useState<EnrichedVisit | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<number | null>(null);
  const [leaveBusyId, setLeaveBusyId] = useState<number | null>(null);
  const [bafRefreshKey, setBafRefreshKey] = useState(0);
  const [bafDialogOpen, setBafDialogOpen] = useState(false);
  const [bafInviteClassId, setBafInviteClassId] = useState<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const section = parseMyClassSection(searchParams.get("section"));
  const focusClassId = /^\d{1,12}$/.test(String(searchParams.get("classId") || ""))
    ? Number(searchParams.get("classId"))
    : null;

  function setSection(id: MyClassSection) {
    setSearchParams({ section: id }, { replace: true });
  }

  const { status: bafStatus, loading: bafLoading, reload: reloadBaf } = useBringAFriendStatus(
    accessToken,
    bafRefreshKey,
  );

  const bumpBafRefresh = useCallback(() => {
    setBafRefreshKey((k) => k + 1);
  }, []);

  const upcoming = useMemo(() => upcomingVisitsFromSummary(summary), [summary]);
  const waitlistVisits = useMemo(() => upcomingWaitlistVisitsFromSummary(summary), [summary]);
  const waitlistMap = useMemo(() => buildWaitlistEntryMap(summary), [summary]);
  const past = useMemo(() => completedVisitsFromSummary(summary), [summary]);

  const loadSchedule = useCallback(async () => {
    if (!isLoggedIn) return;
    setScheduleLoading(true);
    try {
      const visits = [...upcomingVisitsFromSummary(summary), ...upcomingWaitlistVisitsFromSummary(summary)];
      let q = scheduleQueryParams();
      if (visits.length > 0) q = scheduleQueryParamsForVisits(visits);
      const scheduleData = await apiJson<unknown>(`/api/mindbody/class/classes?${q}`, null);
      setScheduleByClassId(buildScheduleClassMap(scheduleData));
    } catch {
      /* show visits without rich descriptions */
    } finally {
      setScheduleLoading(false);
    }
  }, [isLoggedIn, summary]);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  const pageRef = useRef<HTMLDivElement>(null);
  const handleRefresh = useCallback(async () => {
    await reloadSummary();
    await reloadBaf();
  }, [reloadSummary, reloadBaf]);
  const { pulling, refreshing } = usePullToRefresh(pageRef, {
    onRefresh: handleRefresh,
    enabled: isLoggedIn,
  });

  const upcomingRows = useMemo<EnrichedVisit[]>(
    () =>
      upcoming.map((visit) => ({
        visit,
        cls: classShapeForVisit(visit, scheduleByClassId),
      })),
    [upcoming, scheduleByClassId],
  );

  const waitlistRows = useMemo<WaitlistItem[]>(() => {
    const visitByClassId = new Map<number, VisitRow>();
    for (const visit of waitlistVisits) {
      const cid = visitClassId(visit);
      if (cid != null) visitByClassId.set(cid, visit);
    }
    return [...waitlistMap.entries()].map(([classId, entryId]) => ({
      classId,
      entryId,
      cls: scheduleByClassId.get(classId) ?? null,
      visit: visitByClassId.get(classId) ?? null,
    }));
  }, [waitlistMap, waitlistVisits, scheduleByClassId]);

  useEffect(() => {
    if (focusClassId == null) return;
    const el = document.querySelector(`[data-class-id="${focusClassId}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusClassId, section, upcomingRows.length, waitlistRows.length]);

  async function submitCancel(
    classIdNum: number,
    visitId: number,
    cls: Record<string, unknown>,
    opts?: CancelBookingOptions,
  ) {
    if (!accessToken) return;
    setCancelBusyId(visitId);
    setMsg(null);
    try {
      const result = await cancelBooking(accessToken, classIdNum, visitId, cls, opts);
      if (result.ok) {
        setMsg({ text: result.message, kind: "ok" });
        setPendingCancel(null);
        await refreshProfile();
        await reloadSummary();
        bumpBafRefresh();
        void reloadBaf();
      } else {
        setMsg({ text: result.message, kind: "err" });
      }
    } finally {
      setCancelBusyId(null);
    }
  }

  async function submitLeaveWaitlist(entryId: number) {
    if (!accessToken) return;
    setLeaveBusyId(entryId);
    setMsg(null);
    try {
      await apiJson("/api/mindbody/class/waitlist/remove", accessToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitlistEntryId: entryId }),
      });
      setMsg({ text: "Removed from the waitlist.", kind: "ok" });
      await refreshProfile();
      await reloadSummary();
    } catch (e) {
      setMsg({
        text: e instanceof Error ? e.message : "Could not leave the waitlist.",
        kind: "err",
      });
    } finally {
      setLeaveBusyId(null);
    }
  }

  if (!isLoggedIn) {
    return (
      <SignedOutGate
        title="My Classes"
        lede="Sign in to see upcoming bookings, waitlist, and past visits."
      >
        <Link className="btn btn--ghost" to="/schedule">
          Browse schedule
        </Link>
      </SignedOutGate>
    );
  }

  const loading = (summaryLoading && !summary) || (scheduleLoading && upcomingRows.length === 0 && !summary);

  return (
    <div className="my-classes-page" ref={pageRef}>
      {(pulling || refreshing) && (
        <div className="page-ptr" aria-live="polite">
          {refreshing ? "Refreshing…" : "Pull to refresh"}
        </div>
      )}
      {loading ? (
        <div className="spinner">Loading…</div>
      ) : summaryError && !summary ? (
        <div className="error-banner">{summaryError}</div>
      ) : (
        <>
      <h1 className="schedule-page__title">My Classes</h1>

      {msg && (
        <div className={msg.kind === "ok" ? "success-banner" : "error-banner"} style={{ marginBottom: "0.85rem" }}>
          {msg.text}
        </div>
      )}

      <div className="my-classes-tabs" role="tablist" aria-label="Class lists">
        {(
          [
            ["upcoming", "Upcoming", upcomingRows.length],
            ["waitlist", "Waitlist", waitlistRows.length],
            ["past", "Past", past.length],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={`my-classes-tabs__btn${section === id ? " is-active" : ""}`}
            onClick={() => setSection(id)}
          >
            {label}
            {count > 0 ? <span className="my-classes-tabs__count">{count}</span> : null}
          </button>
        ))}
      </div>

      {section === "upcoming" && (
        <section className="my-classes-section">
          {upcomingRows.length === 0 ? (
            <div className="empty">
              No upcoming classes booked.{" "}
              <Link to="/schedule">Book a class</Link>
            </div>
          ) : (
            <ul className="my-classes-list">
              {upcomingRows.map(({ visit, cls }, i) => {
                const vid = visitRowId(visit);
                const cid = visitClassId(visit);
                return (
                  <li
                    key={visitRowKey(visit, i)}
                    data-class-id={cid ?? undefined}
                    className={focusClassId != null && cid === focusClassId ? "is-push-focus" : undefined}
                  >
                    <MyClassVisitCard
                      visit={visit}
                      cls={cls}
                      cancelBusy={vid != null && cancelBusyId === vid}
                      onCancel={() => setPendingCancel({ visit, cls })}
                      showInviteGuest={isClassEligibleForGuestInvite(bafStatus, cid)}
                      onInviteGuest={
                        cid != null
                          ? () => {
                              setBafInviteClassId(cid);
                              setBafDialogOpen(true);
                            }
                          : undefined
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {accessToken && (
            <BringAFriendSection
              compact
              accessToken={accessToken}
              status={bafStatus}
              statusLoading={bafLoading}
              dialogOpen={bafDialogOpen}
              inviteClassId={bafInviteClassId}
              onDialogOpenChange={(open) => {
                setBafDialogOpen(open);
                if (!open) setBafInviteClassId(null);
              }}
              onBooked={() => {
                bumpBafRefresh();
                void reloadBaf();
                void reloadSummary();
              }}
            />
          )}
        </section>
      )}

      {section === "waitlist" && (
        <section className="my-classes-section">
          {waitlistRows.length === 0 ? (
            <div className="empty">You’re not on a waitlist.</div>
          ) : (
            <ul className="my-classes-list">
              {waitlistRows.map((row) => (
                <li
                  key={`${row.classId}-${row.entryId}`}
                  data-class-id={row.classId}
                  className={focusClassId != null && row.classId === focusClassId ? "is-push-focus" : undefined}
                >
                  <WaitlistClassCard
                    cls={row.cls}
                    visit={row.visit}
                    classId={row.classId}
                    leaveBusy={leaveBusyId === row.entryId}
                    onLeave={() => void submitLeaveWaitlist(row.entryId)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {section === "past" && (
        <section className="my-classes-section">
          {past.length === 0 ? (
            <div className="empty">No past visits yet.</div>
          ) : (
            <ul className="my-classes-list">
              {past.map((visit, i) => (
                <li key={visitRowKey(visit, i)}>
                  <PastVisitCard visit={visit} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {pendingCancel && visitClassId(pendingCancel.visit) != null && visitRowId(pendingCancel.visit) != null && (
        <CancelClassDialog
          cls={pendingCancel.cls}
          accessToken={accessToken}
          busy={cancelBusyId != null}
          onDismiss={() => setPendingCancel(null)}
          onConfirm={(opts) => {
            const cid = visitClassId(pendingCancel.visit);
            const vid = visitRowId(pendingCancel.visit);
            if (cid != null && vid != null) void submitCancel(cid, vid, pendingCancel.cls, opts);
          }}
        />
      )}
        </>
      )}
    </div>
  );
}
