import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "../../auth/AuthContext";
import {
  fetchNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from "../../api/notifications";
import { openAppNotificationSettings } from "../../lib/notification-settings";
import { isAmarePushClientEnabled } from "../../push/push-flags";
import {
  currentOsPermission,
  registerNativePush,
  requestOsPermission,
  syncInstallation,
  type OsPermission,
} from "../../push/push-session";

const PREF_ROWS: { key: keyof NotificationPreferences; label: string }[] = [
  { key: "class_booking_updates", label: "Class & booking updates" },
  { key: "class_reminders", label: "Class reminders" },
  { key: "waitlist_updates", label: "Waitlist updates" },
  { key: "studio_news", label: "Studio news & offers" },
];

export function isMobilePushFeatureEnabled(): boolean {
  return isAmarePushClientEnabled();
}

function statusLabel(permission: OsPermission, enabled: boolean): "Enabled" | "Notifications are off" {
  if (enabled && permission === "granted") return "Enabled";
  return "Notifications are off";
}

export function NotificationsSection() {
  const { accessToken } = useAuth();
  const pushOn = isMobilePushFeatureEnabled();
  const [permission, setPermission] = useState<OsPermission>("unknown");
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [explainer, setExplainer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPermission = useCallback(async () => {
    setPermission(await currentOsPermission());
  }, []);

  useEffect(() => {
    if (!pushOn) return;
    void refreshPermission();
  }, [pushOn, refreshPermission]);

  useEffect(() => {
    if (!pushOn || !accessToken) return;
    void fetchNotificationPreferences(accessToken)
      .then((res) => setPrefs(res.preferences))
      .catch(() => setError("Could not load notification preferences."));
  }, [pushOn, accessToken]);

  if (!pushOn) {
    return (
      <section className="card profile-section" aria-labelledby="profile-notifications-title">
        <h2 id="profile-notifications-title">Notifications</h2>
        <p className="profile-section__hint">
          Push notifications are not available in this release. Class updates still arrive by email.
        </p>
      </section>
    );
  }

  const enabled = permission === "granted";
  const status = statusLabel(permission, enabled);

  async function enableFromExplainer() {
    setBusy(true);
    setError(null);
    try {
      const next = await requestOsPermission();
      setPermission(next);
      setExplainer(false);
      if (next === "granted") {
        await registerNativePush();
        if (accessToken) await syncInstallation(accessToken, { permissionState: "granted" });
      } else if (accessToken) {
        await syncInstallation(accessToken, { permissionState: next === "denied" ? "denied" : "prompt" });
      }
    } catch {
      setError("Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(key: keyof NotificationPreferences, value: boolean) {
    if (!accessToken || !prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value });
    try {
      const res = await updateNotificationPreferences(accessToken, { [key]: value });
      setPrefs(res.preferences);
      setError(null);
    } catch {
      setPrefs(previous);
      setError("Could not save that preference.");
    }
  }

  return (
    <section className="card profile-section" aria-labelledby="profile-notifications-title">
      <h2 id="profile-notifications-title">Notifications</h2>

      <div className="notify-row notify-row--status">
        <div>
          <strong>Push notifications</strong>
          <p>{status}</p>
        </div>
        {permission === "denied" || (Capacitor.isNativePlatform() && status === "Enabled") ? (
          <button type="button" className="btn btn--ghost notify-row__manage" onClick={() => void openAppNotificationSettings()}>
            Open settings
          </button>
        ) : (
          <button
            type="button"
            className="btn notify-row__manage"
            disabled={busy || !Capacitor.isNativePlatform()}
            onClick={() => setExplainer(true)}
          >
            Enable
          </button>
        )}
      </div>

      {!Capacitor.isNativePlatform() ? (
        <p className="profile-section__hint">Push is available in the AMARÉ Android app.</p>
      ) : null}
      {error ? <p className="profile-section__hint">{error}</p> : null}

      <ul className="notify-prefs">
        {PREF_ROWS.map((row) => (
          <li key={row.key} className="notify-pref">
            <span>{row.label}</span>
            <label className="notify-switch">
              <input
                type="checkbox"
                checked={prefs ? prefs[row.key] : row.key !== "studio_news"}
                disabled={!prefs}
                onChange={(e) => void onToggle(row.key, e.target.checked)}
              />
              <span>{prefs ? (prefs[row.key] ? "On" : "Off") : row.key === "studio_news" ? "Off" : "On"}</span>
            </label>
          </li>
        ))}
      </ul>

      {explainer ? (
        <div className="notify-explainer" role="dialog" aria-labelledby="notify-explainer-title">
          <h3 id="notify-explainer-title">Stay updated on your classes</h3>
          <p>
            AMARÉ can notify you about bookings, waitlist changes, and upcoming classes. We only ask the phone for
            permission after you choose Enable notifications.
          </p>
          <div className="notify-explainer__actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void enableFromExplainer()}>
              {busy ? "Enabling…" : "Enable notifications"}
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setExplainer(false)}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
