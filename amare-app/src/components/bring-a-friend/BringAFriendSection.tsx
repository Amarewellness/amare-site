import { useCallback, useEffect, useState } from "react";
import { apiJson } from "../../api/client";
import {
  bringAFriendHint,
  formatBringAFriendWhen,
  type BringAFriendStatus,
} from "../../lib/bring-a-friend";
import { BringAFriendDialog } from "./BringAFriendDialog";

type Props = {
  accessToken: string;
  refreshKey?: number;
  status?: BringAFriendStatus | null;
  statusLoading?: boolean;
  onBooked?: () => void;
  inviteClassId?: number | null;
  dialogOpen?: boolean;
  onDialogOpenChange?: (open: boolean) => void;
  compact?: boolean;
};

export function BringAFriendSection({
  accessToken,
  refreshKey = 0,
  status: externalStatus,
  statusLoading: externalLoading,
  onBooked,
  inviteClassId: controlledClassId,
  dialogOpen: controlledDialogOpen,
  onDialogOpenChange,
  compact = false,
}: Props) {
  const [internalStatus, setInternalStatus] = useState<BringAFriendStatus | null>(null);
  const [internalLoading, setInternalLoading] = useState(true);
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const [preselectClassId, setPreselectClassId] = useState<number | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const status = externalStatus !== undefined ? externalStatus : internalStatus;
  const loading = externalLoading !== undefined ? externalLoading : internalLoading;

  const dialogOpen = controlledDialogOpen ?? internalDialogOpen;
  const setDialogOpen = onDialogOpenChange ?? setInternalDialogOpen;

  const loadStatus = useCallback(async () => {
    if (externalStatus !== undefined) return;
    setInternalLoading(true);
    try {
      const data = await apiJson<BringAFriendStatus>(
        "/api/mindbody/member/bring-a-friend/status",
        accessToken,
      );
      setInternalStatus(data);
    } catch {
      setInternalStatus(null);
    } finally {
      setInternalLoading(false);
    }
  }, [accessToken, externalStatus]);

  useEffect(() => {
    if (externalStatus !== undefined) return;
    void loadStatus();
  }, [loadStatus, refreshKey, externalStatus]);

  useEffect(() => {
    if (controlledClassId != null && controlledDialogOpen) {
      setPreselectClassId(controlledClassId);
    } else if (!controlledDialogOpen) {
      setPreselectClassId(null);
    }
  }, [controlledClassId, controlledDialogOpen]);

  const resolvedPreselectClassId = controlledClassId ?? preselectClassId;
  const lockClassSelection = controlledClassId != null;

  function renderStatusBadge() {
    if (loading) {
      return <p className="mb-guest-pass__badge">Loading guest pass…</p>;
    }
    if (!status?.eligible) {
      return (
        <p className="mb-guest-pass__badge mb-guest-pass__badge--used">
          Not available on your current plan
        </p>
      );
    }
    const st = String(status.status ?? "");
    if (st === "available") {
      return <p className="mb-guest-pass__badge mb-guest-pass__badge--available">Available</p>;
    }
    if (st === "used" && status.usedFor) {
      const u = status.usedFor;
      return (
        <p className="mb-guest-pass__badge mb-guest-pass__badge--used">
          Used — {u.guestFirstName ?? ""} {u.guestLastInitial ?? ""} ·{" "}
          {formatBringAFriendWhen(u.classStartDateTime ?? undefined)}
        </p>
      );
    }
    if (st === "confirmed_cancelled") {
      return (
        <>
          <p className="mb-guest-pass__badge mb-guest-pass__badge--used">Pass used (cancelled)</p>
          {status.resetsAt ? (
            <p className="mb-guest-pass__renew">
              Renews {formatBringAFriendWhen(status.resetsAt)}
            </p>
          ) : null}
        </>
      );
    }
    if (st === "failed_manual_review") {
      return (
        <p className="mb-guest-pass__badge mb-guest-pass__badge--err">
          Needs studio help — ref {status.supportContext ?? ""}
        </p>
      );
    }
    if (st === "pending") {
      return <p className="mb-guest-pass__badge">Booking in progress…</p>;
    }
    return null;
  }

  const canInvite = status?.eligible === true && status.status === "available";
  const hint = bringAFriendHint(status);
  const eligibleClassCount = status?.upcomingBookedClasses?.length ?? 0;

  const perkBody = compact ? (
    status?.eligible ? (
      <div className="baf-compact">
        {canInvite && eligibleClassCount > 0 ? (
          <button type="button" className="home-perk-link" onClick={() => setDialogOpen(true)}>
            Bring a friend
          </button>
        ) : (
          <p className="baf-compact__status">{hint}</p>
        )}
        {renderStatusBadge()}
      </div>
    ) : null
  ) : (
    <section className="card profile-section bring-a-friend-card">
      <h2>Bring a Friend</h2>
      <p className="profile-section__hint">{hint}</p>
      {renderStatusBadge()}
      {canInvite && eligibleClassCount > 0 && (
        <p className="profile-section__hint bring-a-friend-card__action-hint">
          Tap <strong>Bring a friend</strong> on an upcoming class below to invite your guest.
        </p>
      )}
      {status?.eligible && status.status === "failed_manual_review" && (
        <p className="profile-section__hint">
          Your guest pass slot is locked after a partial booking. Contact the studio with the
          reference above.
        </p>
      )}
    </section>
  );

  return (
    <>
      {perkBody}

      {successMsg && (
        <div className="success-banner" style={{ marginBottom: "0.85rem" }}>
          {successMsg}
        </div>
      )}

      <BringAFriendDialog
        accessToken={accessToken}
        open={dialogOpen}
        status={status}
        preselectClassId={resolvedPreselectClassId}
        lockClassSelection={lockClassSelection}
        onDismiss={() => setDialogOpen(false)}
        onSuccess={(needsWaiver) => {
          setDialogOpen(false);
          let msg = "Your guest is booked! Ask them to arrive 10 minutes early for their waiver.";
          if (needsWaiver) msg += " This is their first visit to AMARÉ.";
          setSuccessMsg(msg);
          if (externalStatus === undefined) void loadStatus();
          onBooked?.();
        }}
      />
    </>
  );
}

export function useBringAFriendStatus(accessToken: string | null, refreshKey = 0) {
  const [status, setStatus] = useState<BringAFriendStatus | null>(null);
  const [loading, setLoading] = useState(!!accessToken);

  const reload = useCallback(async () => {
    if (!accessToken) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await apiJson<BringAFriendStatus>(
        "/api/mindbody/member/bring-a-friend/status",
        accessToken,
      );
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  return { status, loading, reload };
}
