import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiJson, buildScheduleClassMap } from "../api/client";
import { cancelBooking, type CancelBookingOptions } from "../api/cancel-api";
import {
  BringAFriendSection,
  useBringAFriendStatus,
} from "../components/bring-a-friend/BringAFriendSection";
import { CancelClassDialog } from "../components/CancelClassDialog";
import { MyClassVisitCard } from "../components/my-classes/MyClassVisitCard";
import { isClassEligibleForGuestInvite } from "../lib/bring-a-friend";
import {
  classShapeForVisit,
  scheduleQueryParamsForVisits,
  upcomingVisitsFromSummary,
  visitClassId,
  visitRowId,
  visitRowKey,
  type VisitRow,
} from "../lib/visit-utils";

type EnrichedVisit = {
  visit: VisitRow;
  cls: Record<string, unknown>;
};

export function MyClassesScreen() {
  const { accessToken, isLoggedIn, signIn, loading: authLoading, refreshProfile } = useAuth();
  const [rows, setRows] = useState<EnrichedVisit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [pendingCancel, setPendingCancel] = useState<EnrichedVisit | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<number | null>(null);
  const [bafRefreshKey, setBafRefreshKey] = useState(0);
  const [bafDialogOpen, setBafDialogOpen] = useState(false);
  const [bafInviteClassId, setBafInviteClassId] = useState<number | null>(null);

  const { status: bafStatus, loading: bafLoading, reload: reloadBaf } = useBringAFriendStatus(
    accessToken,
    bafRefreshKey,
  );

  const bumpBafRefresh = useCallback(() => {
    setBafRefreshKey((k) => k + 1);
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<unknown>("/api/mindbody/member/summary", accessToken);
      const visits = upcomingVisitsFromSummary(data);

      let scheduleByClassId = new Map<number, Record<string, unknown>>();
      if (visits.length > 0) {
        try {
          const q = scheduleQueryParamsForVisits(visits);
          const scheduleData = await apiJson<unknown>(`/api/mindbody/class/classes?${q}`, null);
          scheduleByClassId = buildScheduleClassMap(scheduleData);
        } catch {
          /* show visits without rich descriptions */
        }
      }

      setRows(
        visits.map((visit) => ({
          visit,
          cls: classShapeForVisit(visit, scheduleByClassId),
        })),
      );
      bumpBafRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [accessToken, bumpBafRefresh]);

  useEffect(() => {
    void load();
  }, [load]);

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
        await load();
        bumpBafRefresh();
        void reloadBaf();
      } else {
        setMsg({ text: result.message, kind: "err" });
      }
    } finally {
      setCancelBusyId(null);
    }
  }

  if (!isLoggedIn) {
    return (
      <div className="gate">
        <p>Sign in to see your upcoming classes.</p>
        <button type="button" className="btn" onClick={signIn}>
          Sign in with Mindbody
        </button>
      </div>
    );
  }

  if (authLoading || loading) return <div className="spinner">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div className="my-classes-page">
      <h1 className="schedule-page__title">My Classes</h1>

      {msg && (
        <div className={msg.kind === "ok" ? "success-banner" : "error-banner"} style={{ marginBottom: "0.85rem" }}>
          {msg.text}
        </div>
      )}

      {accessToken && (
        <BringAFriendSection
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
            void load();
          }}
        />
      )}

      {rows.length === 0 ? (
        <div className="empty">No upcoming classes booked.</div>
      ) : (
        <ul className="my-classes-list">
          {rows.map(({ visit, cls }, i) => {
            const vid = visitRowId(visit);
            const cid = visitClassId(visit);
            return (
              <li key={visitRowKey(visit, i)}>
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
    </div>
  );
}
