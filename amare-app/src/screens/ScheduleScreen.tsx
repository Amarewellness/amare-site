import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  apiJson,
  ApiError,
  classId,
  classStart,
  classesFromPayload,
  scheduleQueryParams,
} from "../api/client";
import { cancelBooking, cancelGuestOnly, fetchGuestCancelPreflight, type CancelBookingOptions, type GuestCancelPreflight } from "../api/cancel-api";
import { parseBookFailure } from "../api/booking-errors";
import {
  bookPayloadForPolicy,
  cancellationPolicyFromSummary,
  parseCancellationPolicyRaw,
  type CancellationPolicy,
} from "../lib/cancellation-policy";
import { BookClassDialog } from "../components/BookClassDialog";
import { CancelClassDialog } from "../components/CancelClassDialog";
import { RemoveGuestDialog } from "../components/RemoveGuestDialog";
import { useBringAFriendStatus } from "../components/bring-a-friend/BringAFriendSection";
import {
  canShowRemoveGuestOnSchedule,
  guestBadgeForVisit,
  guestBadgeLookupFromBafStatus,
  preflightAllowsRemoveGuestOnly,
} from "../lib/bring-a-friend";
import { ClassSlotRow } from "../components/schedule/ClassSlotRow";
import { ClassTypeSelect } from "../components/schedule/ClassTypeSelect";
import { DayStrip, enrollmentDaysFromRows } from "../components/schedule/DayStrip";
import { emptyFilters, ScheduleFilters } from "../components/schedule/ScheduleFilters";
import { AppHero } from "../components/AppHero";
import { ScheduleRowsSkeleton } from "../components/LoadingSkeletons";
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

type ScheduleBusyOp = "book" | "cancel" | "joinWaitlist" | "leaveWaitlist" | "removeGuest";
type ScheduleBusy = { classId: number; op: ScheduleBusyOp };

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
  const [bookPolicyOverride, setBookPolicyOverride] = useState<CancellationPolicy | null>(null);
  const [pendingIntent, setPendingIntent] = useState<"book" | "waitlist">("book");
  const [pendingCancel, setPendingCancel] = useState<{
    cls: Record<string, unknown>;
    visitId: number;
  } | null>(null);
  const [pendingRemoveGuest, setPendingRemoveGuest] = useState<{
    cls: Record<string, unknown>;
    preflight: GuestCancelPreflight;
  } | null>(null);
  const [removeGuestPreflightBusy, setRemoveGuestPreflightBusy] = useState<number | null>(null);
  const [busy, setBusy] = useState<ScheduleBusy | null>(null);
  const [enrollmentPatch, setEnrollmentPatch] = useState<Map<number, number | null>>(new Map());
  const [waitlistPatch, setWaitlistPatch] = useState<Map<number, number | null>>(new Map());
  const [scheduleTick, setScheduleTick] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);

  const { status: bafStatus, reload: reloadBaf } = useBringAFriendStatus(
    isLoggedIn ? accessToken : null,
  );
  const guestBadgeLookup = useMemo(
    () => guestBadgeLookupFromBafStatus(bafStatus),
    [bafStatus],
  );

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
    await reloadBaf();
    setEnrollmentPatch(new Map());
    setWaitlistPatch(new Map());
  }

  const handleRefresh = useCallback(async () => {
    setEnrollmentPatch(new Map());
    setWaitlistPatch(new Map());
    await Promise.all([
      loadSchedule({ forceFresh: true }),
      isLoggedIn ? reloadSummary() : Promise.resolve(),
      isLoggedIn ? reloadBaf() : Promise.resolve(),
    ]);
  }, [isLoggedIn, loadSchedule, reloadSummary, reloadBaf]);

  const { pulling, refreshing } = usePullToRefresh(pageRef, {
    onRefresh: handleRefresh,
    ignoreClosest: ".mb-schedule-api__surface",
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

  async function submitBook(id: number, policyAcknowledged = false) {
    if (!accessToken) return;
    if (!isOnlineBookingAllowed(profile)) {
      setPendingClass(null);
      return;
    }
    setBusy({ classId: id, op: "book" });
    setBookMsg(null);
    const policy =
      bookPolicyOverride ?? cancellationPolicyFromSummary(summary);
    const clsRow = allRows.find((r) => classId(r.cls) === id)?.cls;
    const classStartIso = clsRow ? classStart(clsRow).trim().slice(0, 40) : "";
    try {
      const res = await apiJson<{ visitId?: number }>("/api/mindbody/class/book", accessToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          bookPayloadForPolicy(id, policy, {}, policyAcknowledged, classStartIso || null),
        ),
      });
      const vid = typeof res.visitId === "number" && res.visitId > 0 ? res.visitId : null;
      if (vid != null) applyEnrollmentPatch(id, vid);
      setBookMsg({
        text: "Booked! Check your email for confirmation — see My Classes for upcoming visits.",
        kind: "ok",
      });
      setPendingClass(null);
      setBookPolicyOverride(null);
      await refreshAfterBooking();
    } catch (e) {
      const fail = parseBookFailure(e);
      const errBody =
        e instanceof ApiError && e.body && typeof e.body === "object"
          ? (e.body as Record<string, unknown>)
          : null;
      if (errBody?.error === "unlimited_policy_ack_required") {
        const apiPolicy = parseCancellationPolicyRaw(errBody.cancellationPolicy);
        if (apiPolicy) setBookPolicyOverride(apiPolicy);
        setBookMsg({
          text: "Please confirm the Unlimited member policy checkbox before booking.",
          kind: "err",
        });
        return;
      }
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
      setBusy(null);
    }
  }

  async function submitWaitlistJoin(id: number, policyAcknowledged = false) {
    if (!accessToken) return;
    setBusy({ classId: id, op: "joinWaitlist" });
    setBookMsg(null);
    const policy = bookPolicyOverride ?? cancellationPolicyFromSummary(summary);
    const clsRow = allRows.find((r) => classId(r.cls) === id)?.cls;
    const classStartIso = clsRow ? classStart(clsRow).trim().slice(0, 40) : "";
    try {
      const res = await apiJson<{ waitlistEntryId?: number }>(
        "/api/mindbody/class/book",
        accessToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            bookPayloadForPolicy(
              id,
              policy,
              { waitlist: true },
              policyAcknowledged,
              classStartIso || null,
            ),
          ),
        },
      );
      const eid =
        typeof res.waitlistEntryId === "number" && res.waitlistEntryId > 0
          ? res.waitlistEntryId
          : null;
      if (eid != null) applyWaitlistPatch(id, eid);
      setBookMsg({ text: "You're on the waitlist — we'll email you if a spot opens.", kind: "ok" });
      setPendingClass(null);
      setBookPolicyOverride(null);
      await refreshAfterBooking();
    } catch (e) {
      const fail = parseBookFailure(e);
      const errBody =
        e instanceof ApiError && e.body && typeof e.body === "object"
          ? (e.body as Record<string, unknown>)
          : null;
      if (errBody?.error === "unlimited_policy_ack_required") {
        const apiPolicy = parseCancellationPolicyRaw(errBody.cancellationPolicy);
        if (apiPolicy) setBookPolicyOverride(apiPolicy);
        setBookMsg({
          text: "Please confirm the Unlimited member policy checkbox before joining the waitlist.",
          kind: "err",
        });
        return;
      }
      setBookMsg({ text: fail.message, kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  async function submitWaitlistLeave(entryId: number, cid: number) {
    if (!accessToken) return;
    setBusy({ classId: cid, op: "leaveWaitlist" });
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
      setBusy(null);
    }
  }

  async function submitCancel(
    classIdNum: number,
    visitId: number,
    cls: Record<string, unknown>,
    opts?: CancelBookingOptions,
  ) {
    if (!accessToken) return;
    setBusy({ classId: classIdNum, op: "cancel" });
    setBookMsg(null);
    try {
      const result = await cancelBooking(accessToken, classIdNum, visitId, cls, opts, summary);
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
      setBusy(null);
    }
  }

  async function beginRemoveGuest(cls: Record<string, unknown>, classIdNum: number) {
    if (!accessToken) return;
    setRemoveGuestPreflightBusy(classIdNum);
    setBookMsg(null);
    try {
      const preflight = await fetchGuestCancelPreflight(accessToken, classIdNum);
      if (!preflightAllowsRemoveGuestOnly(preflight)) {
        setBookMsg({
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
    setBusy({ classId: classIdNum, op: "removeGuest" });
    setBookMsg(null);
    try {
      const result = await cancelGuestOnly(accessToken, classIdNum, period);
      if (result.ok) {
        setBookMsg({ text: result.message, kind: "ok" });
        setPendingRemoveGuest(null);
        await refreshAfterBooking();
      } else {
        setBookMsg({ text: result.message, kind: "err" });
      }
    } finally {
      setBusy(null);
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
      <AppHero />
      {error && allRows.length === 0 && !bootstrapping ? (
        <div className="error-banner">{error}</div>
      ) : null}
      <h2 className="schedule-page__title">Book a class</h2>

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
                  setBookPolicyOverride(null);
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

        {bootstrapping ? (
          <ScheduleRowsSkeleton />
        ) : forDay.length === 0 ? (
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
              const guestBadge = guestBadgeForVisit(guestBadgeLookup, cid, row.isoMs);
              const rowBusyOp = busy?.classId === cid ? busy.op : null;

              return (
                <ClassSlotRow
                  key={cid}
                  cls={row.cls}
                  isoMs={row.isoMs}
                  isLoggedIn={isLoggedIn}
                  isEnrolled={isEnrolled}
                  onWaitlist={onWaitlist}
                  showJoinWaitlist={joinWaitlistAvailable}
                  busyOp={rowBusyOp}
                  guestBadge={guestBadge}
                  showRemoveGuest={canShowRemoveGuestOnSchedule(guestBadge, row.isoMs)}
                  removeGuestPreflightBusy={removeGuestPreflightBusy === cid}
                  onBook={() => {
                    setBookMsg(null);
                    setPendingIntent("book");
                    setBookPolicyOverride(null);
                    setPendingClass(row.cls);
                  }}
                  onCancel={() => {
                    if (visitId != null) {
                      setPendingRemoveGuest(null);
                      setPendingCancel({ cls: row.cls, visitId });
                    }
                  }}
                  onRemoveGuest={() => void beginRemoveGuest(row.cls, cid)}
                  onJoinWaitlist={() => {
                    setBookMsg(null);
                    setPendingIntent("waitlist");
                    setBookPolicyOverride(null);
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
          policyOverride={bookPolicyOverride}
          summaryLoading={walletLoading && !summary}
          accessToken={accessToken}
          busy={busy != null}
          intent={pendingIntent}
          blockedTitle={bookingBlocked ? bookingBlockedTitle(profile?.linkStatus) : null}
          blockedMessage={bookingBlocked ? bookingBlockedMessage(profile?.linkStatus) : null}
          onCancel={() => {
            setPendingClass(null);
            setBookPolicyOverride(null);
          }}
          onConfirm={(policyAcknowledged) => {
            const id = classId(pendingClass);
            if (id == null) return;
            if (pendingIntent === "waitlist") void submitWaitlistJoin(id, policyAcknowledged);
            else void submitBook(id, policyAcknowledged);
          }}
        />
      )}

      {pendingCancel && classId(pendingCancel.cls) != null && (
        <CancelClassDialog
          cls={pendingCancel.cls}
          summary={summary}
          accessToken={accessToken}
          busy={busy != null}
          onDismiss={() => setPendingCancel(null)}
          onRemoveGuestOnly={(preflight) => {
            setPendingCancel(null);
            setPendingRemoveGuest({ cls: pendingCancel.cls, preflight });
          }}
          onConfirm={(opts) => {
            const id = classId(pendingCancel.cls);
            if (id != null) void submitCancel(id, pendingCancel.visitId, pendingCancel.cls, opts);
          }}
        />
      )}

      {pendingRemoveGuest && classId(pendingRemoveGuest.cls) != null && (
        <RemoveGuestDialog
          cls={pendingRemoveGuest.cls}
          preflight={pendingRemoveGuest.preflight}
          busy={busy?.op === "removeGuest"}
          onDismiss={() => setPendingRemoveGuest(null)}
          onConfirm={() => {
            const id = classId(pendingRemoveGuest.cls);
            if (id == null) return;
            const period =
              typeof pendingRemoveGuest.preflight.period === "string"
                ? pendingRemoveGuest.preflight.period
                : undefined;
            void submitRemoveGuest(id, period);
          }}
        />
      )}
    </div>
  );
}
