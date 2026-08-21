import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  apiJson,
  classId,
  classesFromPayload,
  scheduleQueryParams,
} from "../api/client";
import { cancelBooking, type CancelBookingOptions } from "../api/cancel-api";
import { parseBookFailure } from "../api/booking-errors";
import { bookPayloadForPolicy, cancellationPolicyFromSummary } from "../lib/cancellation-policy";
import { BookClassDialog } from "../components/BookClassDialog";
import { CancelClassDialog } from "../components/CancelClassDialog";
import { ClassSlotRow } from "../components/schedule/ClassSlotRow";
import { ClassTypeSelect } from "../components/schedule/ClassTypeSelect";
import { DayStrip, enrollmentDaysFromRows } from "../components/schedule/DayStrip";
import { emptyFilters, ScheduleFilters } from "../components/schedule/ScheduleFilters";
import { ScheduleWallet } from "../components/schedule/ScheduleWallet";
import { MemberTopUpCard } from "../components/MemberTopUpCard";
import {
  bookingBlockedMessage,
  bookingBlockedTitle,
  isOnlineBookingAllowed,
} from "../lib/booking-link";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import {
  buildEnrollmentVisitMap,
  buildWaitlistEntryMap,
  mergeEnrollmentVisitMaps,
  mergeWaitlistEntryMaps,
} from "../lib/member-summary";
import {
  countsByDay,
  dateKeyEt,
  formatDayHeading,
  normalizeClassRow,
  passesSecondaryFilters,
  shouldShowJoinWaitlist,
  stripKeysFromTodayEt,
  type FilterState,
  type ScheduleRow,
  uniqueClassTitlesForDay,
  uniqueInstructors,
} from "../lib/schedule-utils";

type BookMsg = {
  text: string;
  kind: "ok" | "err";
  showPricing?: boolean;
  refreshSchedule?: boolean;
  joinWaitlistClassId?: number;
};

export function ScheduleScreen() {
  const { accessToken, isLoggedIn, signIn, refreshProfile, profile } = useAuth();
  const { summary, loading: walletLoading, reload: reloadSummary } = useMemberSummary();
  const [allRows, setAllRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(emptyFilters());
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState(() => dateKeyEt(Date.now()));
  const [bookMsg, setBookMsg] = useState<BookMsg | null>(null);
  const [pendingClass, setPendingClass] = useState<Record<string, unknown> | null>(null);
  const [pendingIntent, setPendingIntent] = useState<"book" | "waitlist">("book");
  const [pendingCancel, setPendingCancel] = useState<{
    cls: Record<string, unknown>;
    visitId: number;
  } | null>(null);
  const [busyClassId, setBusyClassId] = useState<number | null>(null);
  const [enrollmentPatch, setEnrollmentPatch] = useState<Map<number, number | null>>(new Map());
  const [waitlistPatch, setWaitlistPatch] = useState<Map<number, number | null>>(new Map());
  const [scheduleTick, setScheduleTick] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);

  const stripKeys = useMemo(() => stripKeysFromTodayEt(), []);
  const todayKey = useMemo(() => dateKeyEt(Date.now()), [scheduleTick]);

  const loadSchedule = useCallback(async (opts?: { forceFresh?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      let q = scheduleQueryParams();
      if (opts?.forceFresh) q += `&_t=${Date.now()}`;
      const data = await apiJson<unknown>(`/api/mindbody/class/classes?${q}`, null);
      const rows = classesFromPayload(data)
        .map(normalizeClassRow)
        .filter((r): r is ScheduleRow => r != null)
        .sort((a, b) => a.isoMs - b.isoMs);
      setAllRows(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "schedule_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  useEffect(() => {
    if (selectedDayKey !== todayKey) return;
    const id = window.setInterval(() => setScheduleTick((t) => t + 1), 55000);
    return () => window.clearInterval(id);
  }, [selectedDayKey, todayKey]);

  const enrollVisitByClassId = useMemo(
    () => mergeEnrollmentVisitMaps(buildEnrollmentVisitMap(summary), enrollmentPatch),
    [summary, enrollmentPatch],
  );

  const waitlistEntryByClassId = useMemo(
    () => mergeWaitlistEntryMaps(buildWaitlistEntryMap(summary), waitlistPatch),
    [summary, waitlistPatch],
  );

  const secondaryFiltered = useMemo(
    () => allRows.filter((r) => passesSecondaryFilters(r, filters)),
    [allRows, filters],
  );

  const dayCounts = useMemo(() => countsByDay(secondaryFiltered), [secondaryFiltered]);

  const enrollmentDays = useMemo(
    () => enrollmentDaysFromRows(allRows, enrollVisitByClassId),
    [allRows, enrollVisitByClassId],
  );

  const classTitlesForDay = useMemo(
    () => uniqueClassTitlesForDay(allRows, selectedDayKey, { ...filters, classTitle: "" }),
    [allRows, selectedDayKey, filters],
  );

  const instructors = useMemo(() => uniqueInstructors(allRows), [allRows]);

  useEffect(() => {
    if (filters.classTitle && !classTitlesForDay.includes(filters.classTitle)) {
      setFilters((f) => ({ ...f, classTitle: "" }));
    }
  }, [filters.classTitle, classTitlesForDay]);

  const forDay = useMemo(() => {
    const now = Date.now();
    return secondaryFiltered
      .filter((r) => r.dk === selectedDayKey && r.isoMs > now - 60000)
      .sort((a, b) => a.isoMs - b.isoMs);
  }, [secondaryFiltered, selectedDayKey, scheduleTick]);

  async function refreshAfterBooking() {
    await refreshProfile();
    await reloadSummary();
    setEnrollmentPatch(new Map());
    setWaitlistPatch(new Map());
  }

  const handleRefresh = useCallback(async () => {
    setEnrollmentPatch(new Map());
    setWaitlistPatch(new Map());
    await Promise.all([
      loadSchedule({ forceFresh: true }),
      isLoggedIn ? reloadSummary() : Promise.resolve(),
    ]);
  }, [isLoggedIn, loadSchedule, reloadSummary]);

  const { pulling, refreshing } = usePullToRefresh(pageRef, {
    onRefresh: handleRefresh,
  });

  function applyEnrollmentPatch(cid: number, visitId: number | null) {
    setEnrollmentPatch((prev) => {
      const next = new Map(prev);
      if (visitId == null) next.set(cid, null);
      else next.set(cid, visitId);
      return next;
    });
  }

  function applyWaitlistPatch(cid: number, entryId: number | null) {
    setWaitlistPatch((prev) => {
      const next = new Map(prev);
      if (entryId == null) next.set(cid, null);
      else next.set(cid, entryId);
      return next;
    });
  }

  async function submitBook(id: number) {
    if (!accessToken) return;
    if (!isOnlineBookingAllowed(profile)) {
      setPendingClass(null);
      return;
    }
    setBusyClassId(id);
    setBookMsg(null);
    try {
      const res = await apiJson<{ visitId?: number }>("/api/mindbody/class/book", accessToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookPayloadForPolicy(id, cancellationPolicyFromSummary(summary))),
      });
      const vid = typeof res.visitId === "number" && res.visitId > 0 ? res.visitId : null;
      if (vid != null) applyEnrollmentPatch(id, vid);
      setBookMsg({
        text: "Booked! Check your email for confirmation — see My Classes for upcoming visits.",
        kind: "ok",
      });
      setPendingClass(null);
      await refreshAfterBooking();
    } catch (e) {
      const fail = parseBookFailure(e);
      const clsRow = allRows.find((r) => classId(r.cls) === id)?.cls;
      const offerWaitlist =
        fail.noLongerAvailable && fail.classFull && clsRow != null && shouldShowJoinWaitlist(clsRow);
      setBookMsg({
        text: fail.message,
        kind: "err",
        showPricing: fail.suggestPackages && !fail.paymentMismatch,
        refreshSchedule: fail.noLongerAvailable,
        joinWaitlistClassId: offerWaitlist ? id : undefined,
      });
      if (fail.noLongerAvailable) void loadSchedule({ forceFresh: true });
    } finally {
      setBusyClassId(null);
    }
  }

  async function submitWaitlistJoin(id: number) {
    if (!accessToken) return;
    setBusyClassId(id);
    setBookMsg(null);
    try {
      const res = await apiJson<{ waitlistEntryId?: number }>(
        "/api/mindbody/class/book",
        accessToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            bookPayloadForPolicy(id, cancellationPolicyFromSummary(summary), { waitlist: true }),
          ),
        },
      );
      const eid =
        typeof res.waitlistEntryId === "number" && res.waitlistEntryId > 0
          ? res.waitlistEntryId
          : null;
      if (eid != null) applyWaitlistPatch(id, eid);
      setBookMsg({ text: "You're on the waitlist — we'll email you if a spot opens.", kind: "ok" });
      await refreshAfterBooking();
    } catch (e) {
      const fail = parseBookFailure(e);
      setBookMsg({ text: fail.message, kind: "err" });
    } finally {
      setBusyClassId(null);
    }
  }

  async function submitWaitlistLeave(entryId: number, cid: number) {
    if (!accessToken) return;
    setBusyClassId(cid);
    setBookMsg(null);
    try {
      await apiJson("/api/mindbody/class/waitlist/remove", accessToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitlistEntryId: entryId }),
      });
      applyWaitlistPatch(cid, null);
      setBookMsg({ text: "Removed from the waitlist.", kind: "ok" });
      await refreshAfterBooking();
    } catch (e) {
      setBookMsg({
        text: e instanceof Error ? e.message : "Could not leave the waitlist.",
        kind: "err",
      });
    } finally {
      setBusyClassId(null);
    }
  }

  async function submitCancel(
    classIdNum: number,
    visitId: number,
    cls: Record<string, unknown>,
    opts?: CancelBookingOptions,
  ) {
    if (!accessToken) return;
    setBusyClassId(classIdNum);
    setBookMsg(null);
    try {
      const result = await cancelBooking(accessToken, classIdNum, visitId, cls, opts);
      if (result.ok) {
        applyEnrollmentPatch(classIdNum, null);
        setBookMsg({ text: result.message, kind: "ok" });
        setPendingCancel(null);
        await refreshAfterBooking();
      } else if (result.noLongerAvailable) {
        setBookMsg({ text: result.message, kind: "err", refreshSchedule: true });
        setPendingCancel(null);
        void loadSchedule({ forceFresh: true });
      } else {
        setBookMsg({ text: result.message, kind: "err" });
      }
    } finally {
      setBusyClassId(null);
    }
  }

  const bookingBlocked = isLoggedIn && !isOnlineBookingAllowed(profile);
  const bootstrapping = loading && allRows.length === 0;

  return (
    <div className="schedule-page" ref={pageRef}>
      {(pulling || refreshing) && (
        <div className="page-ptr" aria-live="polite">
          {refreshing ? "Refreshing…" : "Pull to refresh"}
        </div>
      )}
      {bootstrapping ? (
        <div className="spinner">Loading schedule…</div>
      ) : error && allRows.length === 0 ? (
        <div className="error-banner">{error}</div>
      ) : (
        <>
      <h1 className="schedule-page__title">Book a class</h1>

      {!isLoggedIn ? (
        <div className="mb-auth-bar" aria-live="polite">
          <span>Sign in to book with your AMARÉ account.</span>
          <button type="button" className="btn" onClick={signIn}>
            Sign in
          </button>
        </div>
      ) : (
        <>
          <ScheduleWallet summary={summary} loading={walletLoading} compact />
          {accessToken ? <MemberTopUpCard accessToken={accessToken} compact /> : null}
        </>
      )}

      <ScheduleFilters
        filters={filters}
        instructors={instructors}
        classTitles={classTitlesForDay}
        expanded={filtersExpanded}
        onToggleExpanded={() => setFiltersExpanded((e) => !e)}
        onChange={setFilters}
        onClear={() => setFilters((f) => ({ ...emptyFilters(), classKind: f.classKind }))}
      />

      {bookMsg && (
        <div
          className={bookMsg.kind === "ok" ? "success-banner" : "error-banner"}
          style={{ marginBottom: "0.85rem" }}
        >
          {bookMsg.text}
          {bookMsg.kind === "err" && bookMsg.showPricing && (
            <>
              {" "}
              <Link className="mb-schedule-msg-action" to="/purchase">
                Buy a pass
              </Link>
            </>
          )}
          {bookMsg.kind === "err" && bookMsg.refreshSchedule && (
            <>
              {" "}
              <button
                type="button"
                className="mb-schedule-msg-action"
                onClick={() => void loadSchedule({ forceFresh: true })}
              >
                Refresh schedule
              </button>
            </>
          )}
          {bookMsg.kind === "err" && bookMsg.joinWaitlistClassId != null && (
            <>
              {" "}
              <button
                type="button"
                className="mb-schedule-msg-action"
                onClick={() => {
                  const id = bookMsg.joinWaitlistClassId;
                  const clsRow = allRows.find((r) => classId(r.cls) === id)?.cls;
                  if (!clsRow) return;
                  setPendingIntent("waitlist");
                  setPendingClass(clsRow);
                }}
              >
                Join waitlist
              </button>
            </>
          )}
        </div>
      )}

      <div className="mb-frame mb-schedule-api__surface" aria-busy={loading ? "true" : "false"}>
        <DayStrip
          stripKeys={stripKeys}
          selectedDayKey={selectedDayKey}
          counts={dayCounts}
          enrollmentByDay={enrollmentDays}
          onSelect={setSelectedDayKey}
        />

        <ClassTypeSelect filters={filters} onChange={setFilters} />

        <h2 className="mb-schedule-day__label">{formatDayHeading(selectedDayKey)}</h2>

        {forDay.length === 0 ? (
          <p className="mb-schedule-api__empty">
            No classes match your filters for {formatDayHeading(selectedDayKey)}.
          </p>
        ) : (
          <ul className="mb-schedule-list">
            {forDay.map((row) => {
              const cid = classId(row.cls);
              if (cid == null) return null;
              const visitId = enrollVisitByClassId.get(cid);
              const waitlistEntryId = waitlistEntryByClassId.get(cid);
              const isEnrolled = isLoggedIn && visitId != null;
              const onWaitlist = isLoggedIn && !isEnrolled && waitlistEntryId != null;
              const joinWaitlistAvailable =
                !isEnrolled && !onWaitlist && shouldShowJoinWaitlist(row.cls);

              return (
                <ClassSlotRow
                  key={cid}
                  cls={row.cls}
                  isoMs={row.isoMs}
                  isLoggedIn={isLoggedIn}
                  isEnrolled={isEnrolled}
                  onWaitlist={onWaitlist}
                  showJoinWaitlist={joinWaitlistAvailable}
                  busy={busyClassId === cid}
                  onBook={() => {
                    setBookMsg(null);
                    setPendingIntent("book");
                    setPendingClass(row.cls);
                  }}
                  onCancel={() => {
                    if (visitId != null) setPendingCancel({ cls: row.cls, visitId });
                  }}
                  onJoinWaitlist={() => {
                    setBookMsg(null);
                    setPendingIntent("waitlist");
                    setPendingClass(row.cls);
                  }}
                  onLeaveWaitlist={() => {
                    if (waitlistEntryId != null) void submitWaitlistLeave(waitlistEntryId, cid);
                  }}
                  onSignIn={signIn}
                />
              );
            })}
          </ul>
        )}
      </div>

      {pendingClass && classId(pendingClass) != null && (
        <BookClassDialog
          cls={pendingClass}
          summary={summary}
          accessToken={accessToken}
          busy={busyClassId != null}
          intent={pendingIntent}
          blockedTitle={bookingBlocked ? bookingBlockedTitle(profile?.linkStatus) : null}
          blockedMessage={bookingBlocked ? bookingBlockedMessage(profile?.linkStatus) : null}
          onCancel={() => setPendingClass(null)}
          onConfirm={() => {
            const id = classId(pendingClass);
            if (id == null) return;
            if (pendingIntent === "waitlist") void submitWaitlistJoin(id);
            else void submitBook(id);
          }}
        />
      )}

      {pendingCancel && classId(pendingCancel.cls) != null && (
        <CancelClassDialog
          cls={pendingCancel.cls}
          accessToken={accessToken}
          busy={busyClassId != null}
          onDismiss={() => setPendingCancel(null)}
          onConfirm={(opts) => {
            const id = classId(pendingCancel.cls);
            if (id != null) void submitCancel(id, pendingCancel.visitId, pendingCancel.cls, opts);
          }}
        />
      )}
        </>
      )}
    </div>
  );
}
