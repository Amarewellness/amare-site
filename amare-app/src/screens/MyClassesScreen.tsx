import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiJson, buildScheduleClassMap, classId, classStart, classTitle, scheduleQueryParams } from "../api/client";
import { cancelBooking, cancelGuestOnly, fetchGuestCancelPreflight, type CancelBookingOptions, type GuestCancelPreflight } from "../api/cancel-api";
import {
  BringAFriendSection,
  useBringAFriendStatus,
} from "../components/bring-a-friend/BringAFriendSection";
import { CancelClassDialog } from "../components/CancelClassDialog";
import { RemoveGuestDialog } from "../components/RemoveGuestDialog";
import { MyClassVisitCard } from "../components/my-classes/MyClassVisitCard";
import { MyClassesWeekView, type WeekClassItem } from "../components/my-classes/MyClassesWeekView";
import { PastVisitCard } from "../components/my-classes/PastVisitCard";
import { WaitlistClassCard } from "../components/my-classes/WaitlistClassCard";
import { AppHero } from "../components/AppHero";
import { MyClassesRowsSkeleton } from "../components/LoadingSkeletons";
import { SignedOutGate } from "../components/SignedOutGate";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { isClassEligibleForGuestInvite, canShowRemoveGuestOnSchedule, guestBadgeForVisit, guestBadgeLookupFromBafStatus, preflightAllowsRemoveGuestOnly } from "../lib/bring-a-friend";
import { buildWaitlistEntryMap } from "../lib/member-summary";
import { mindbodyInstantToUtcMs } from "../lib/mindbody-time";
import { dateKeyEt, startOfWeekEt } from "../lib/schedule-utils";
import {
  classShapeForVisit,
  completedVisitsFromSummary,
  scheduleQueryParamsForVisits,
  upcomingVisitsFromSummary,
  upcomingWaitlistVisitsFromSummary,
  visitClassId,
  visitName,
  visitRowId,
  visitRowKey,
  visitStartMs,
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
  const [pendingRemoveGuest, setPendingRemoveGuest] = useState<{
    cls: Record<string, unknown>;
    preflight: GuestCancelPreflight;
  } | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<number | null>(null);
  const [removeGuestBusyId, setRemoveGuestBusyId] = useState<number | null>(null);
  const [removeGuestPreflightBusy, setRemoveGuestPreflightBusy] = useState<number | null>(null);
  const [leaveBusyId, setLeaveBusyId] = useState<number | null>(null);
  const [bafRefreshKey, setBafRefreshKey] = useState(0);
  const [bafDialogOpen, setBafDialogOpen] = useState(false);
  const [bafInviteClassId, setBafInviteClassId] = useState<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const section = parseMyClassSection(searchParams.get("section"));
  const [listView, setListView] = useState<"list" | "week">("list");
  const [weekStart, setWeekStart] = useState(() => startOfWeekEt(dateKeyEt(Date.now())));
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
  const guestBadgeLookup = useMemo(
    () => guestBadgeLookupFromBafStatus(bafStatus),
    [bafStatus],
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

  const weekItems = useMemo<WeekClassItem[]>(() => {
    const items: WeekClassItem[] = [];
    for (const { visit } of upcomingRows) {
      const ms = visitStartMs(visit);
      if (ms == null) continue;
      items.push({
        id: `b-${visitRowKey(visit, 0)}`,
        dayKey: dateKeyEt(ms),
        isoMs: ms,
        name: visitName(visit),
        kind: "booked",
        classId: visitClassId(visit),
      });
    }
    for (const row of waitlistRows) {
      const fromVisit = row.visit ? visitStartMs(row.visit) : null;
      const fromCls = row.cls ? mindbodyInstantToUtcMs(classStart(row.cls)) : NaN;
      const ms = fromVisit ?? (Number.isFinite(fromCls) ? fromCls : null);
      if (ms == null) continue;
      items.push({
        id: `w-${row.classId}-${row.entryId}`,
        dayKey: dateKeyEt(ms),
        isoMs: ms,
        name: row.visit ? visitName(row.visit) : row.cls ? classTitle(row.cls) : "Class",
        kind: "waitlist",
        classId: row.classId,
      });
    }
    return items;
  }, [upcomingRows, waitlistRows]);

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
      const result = await cancelBooking(accessToken, classIdNum, visitId, cls, opts, summary);
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

  async function beginRemoveGuest(cls: Record<string, unknown>, classIdNum: number) {
    if (!accessToken) return;
    setRemoveGuestPreflightBusy(classIdNum);
    setMsg(null);
    try {
      const preflight = await fetchGuestCancelPreflight(accessToken, classIdNum);
      if (!preflightAllowsRemoveGuestOnly(preflight)) {
        setMsg({
          text: "Guest can only be removed more than 12 hours before class start.",
          kind: "err",
        });
        return;
      }
      setPendingCancel(null);
      setPendingRemoveGuest({ cls, preflight });
    } finally {
      setRemoveGuestPreflightBusy(null);
    }
  }

  async function submitRemoveGuest(classIdNum: number, period?: string) {
    if (!accessToken) return;
    setRemoveGuestBusyId(classIdNum);
    setMsg(null);
    try {
      const result = await cancelGuestOnly(accessToken, classIdNum, period);
      if (result.ok) {
        setMsg({ text: result.message, kind: "ok" });
        setPendingRemoveGuest(null);
        await refreshProfile();
        await reloadSummary();
        bumpBafRefresh();
        void reloadBaf();
      } else {
        setMsg({ text: result.message, kind: "err" });
      }
    } finally {
      setRemoveGuestBusyId(null);
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
      <div className="my-classes-page">
        <AppHero />
      <SignedOutGate
        title="My Classes"
        lede="Sign in to see upcoming bookings, waitlist, and past visits."
      >
        <Link className="btn btn--ghost" to="/schedule">
          Browse schedule
        </Link>
      </SignedOutGate>
      </div>
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
      <AppHero />
      {summaryError && !summary ? <div className="error-banner">{summaryError}</div> : null}
      <div className="my-classes-head">
        <h2 className="schedule-page__title">My Classes</h2>
        {section === "upcoming" ? (
          <div className="my-classes-view" role="tablist" aria-label="Class view">
            <button
              type="button"
              role="tab"
              aria-selected={listView === "list"}
              className={`my-classes-view__btn${listView === "list" ? " is-active" : ""}`}
              onClick={() => setListView("list")}
            >
              List
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={listView === "week"}
              className={`my-classes-view__btn${listView === "week" ? " is-active" : ""}`}
              onClick={() => setListView("week")}
            >
              Week
            </button>
          </div>
        ) : null}
      </div>

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

      {loading ? (
        <MyClassesRowsSkeleton />
      ) : section === "upcoming" && listView === "week" ? (
        <section className="my-classes-section">
          <MyClassesWeekView
            weekStart={weekStart}
            items={weekItems}
            focusClassId={focusClassId}
            onWeekStartChange={setWeekStart}
            onSelect={(item) => {
              setListView("list");
              const next: Record<string, string> = {
                section: item.kind === "waitlist" ? "waitlist" : "upcoming",
              };
              if (item.classId != null) next.classId = String(item.classId);
              setSearchParams(next, { replace: true });
            }}
          />
        </section>
      ) : section === "upcoming" ? (
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
                const whenMs = visitStartMs(visit);
                const guestBadge = guestBadgeForVisit(guestBadgeLookup, cid, whenMs);
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
                      removeGuestBusy={cid != null && removeGuestBusyId === cid}
                      removeGuestPreflightBusy={cid != null && removeGuestPreflightBusy === cid}
                      guestBadge={guestBadge}
                      showRemoveGuest={canShowRemoveGuestOnSchedule(guestBadge, whenMs)}
                      onCancel={() => {
                        setPendingRemoveGuest(null);
                        setPendingCancel({ visit, cls });
                      }}
                      onRemoveGuest={
                        cid != null ? () => void beginRemoveGuest(cls, cid) : undefined
                      }
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
      ) : section === "waitlist" ? (
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
      ) : section === "past" ? (
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
      ) : null}

      {pendingCancel && visitClassId(pendingCancel.visit) != null && visitRowId(pendingCancel.visit) != null && (
        <CancelClassDialog
          cls={pendingCancel.cls}
          summary={summary}
          accessToken={accessToken}
          busy={cancelBusyId != null || removeGuestBusyId != null}
          onDismiss={() => setPendingCancel(null)}
          onRemoveGuestOnly={(preflight) => {
            setPendingCancel(null);
            setPendingRemoveGuest({ cls: pendingCancel.cls, preflight });
          }}
          onConfirm={(opts) => {
            const cid = visitClassId(pendingCancel.visit);
            const vid = visitRowId(pendingCancel.visit);
            if (cid != null && vid != null) void submitCancel(cid, vid, pendingCancel.cls, opts);
          }}
        />
      )}

      {pendingRemoveGuest && classId(pendingRemoveGuest.cls) != null && (
        <RemoveGuestDialog
          cls={pendingRemoveGuest.cls}
          preflight={pendingRemoveGuest.preflight}
          busy={removeGuestBusyId != null}
          onDismiss={() => setPendingRemoveGuest(null)}
          onConfirm={() => {
            const cid = classId(pendingRemoveGuest.cls);
            if (cid == null) return;
            const period =
              typeof pendingRemoveGuest.preflight.period === "string"
                ? pendingRemoveGuest.preflight.period
                : undefined;
            void submitRemoveGuest(cid, period);
          }}
        />
      )}
    </div>
  );
}
