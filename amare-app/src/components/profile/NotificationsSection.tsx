import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "../../auth/AuthContext";
import {
  fetchNotificationPreferences,
  isTransactionalPushEnabled,
  transactionalPrefsPatch,
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

export function isMobilePushFeatureEnabled(): boolean {
  return isAmarePushClientEnabled();
}

function statusMessage(permission: OsPermission, prefs: NotificationPreferences | null): string {
  if (permission === "denied") return "Notifications are blocked in device settings.";
  if (!prefs) return "Loading notification preferences…";
  if (!isTransactionalPushEnabled(prefs)) return "Notifications are off in AMARÉ";
  if (permission === "granted") return "Enabled";
  return "Allow notifications on your device to receive updates.";
}

export function NotificationsSection() {
  const { accessToken } = useAuth();
  const pushOn = isMobilePushFeatureEnabled();
  const [permission, setPermission] = useState<OsPermission>("unknown");
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [prefsState, setPrefsState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPermission = useCallback(async () => {
    setPermission(await currentOsPermission());
  }, []);

  const loadPrefs = useCallback(async () => {
    if (!accessToken) return;
    setPrefsState("loading");
    setError(null);
    try {
      const res = await fetchNotificationPreferences(accessToken);
      setPrefs(res.preferences);
      setPrefsState("ready");
    } catch {
      setPrefs(null);
      setPrefsState("error");
      setError("Could not load notification preferences.");
    }
  }, [accessToken]);

  useEffect(() => {
    if (!pushOn) return;
    void refreshPermission();
  }, [pushOn, refreshPermission]);

  useEffect(() => {
    if (!pushOn || !accessToken) return;
    void loadPrefs();
  }, [pushOn, accessToken, loadPrefs]);

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

  const prefsReady = prefsState === "ready" && prefs !== null;
  const serverEnabled = prefsReady && isTransactionalPushEnabled(prefs);
  const toggleChecked = serverEnabled && permission === "granted";
  const status = statusMessage(permission, prefsReady ? prefs : null);
  const toggleDisabled =
    busy ||
    !Capacitor.isNativePlatform() ||
    prefsState === "loading" ||
    prefsState === "error" ||
    permission === "denied";

  async function onMasterToggle(nextChecked: boolean) {
    if (!accessToken || !prefs || busy) return;

    if (!nextChecked) {
      setBusy(true);
      setError(null);
      const previous = prefs;
      setPrefs({ ...prefs, ...transactionalPrefsPatch(false) });
      try {
        const res = await updateNotificationPreferences(accessToken, transactionalPrefsPatch(false));
        setPrefs(res.preferences);
      } catch {
        setPrefs(previous);
        setError("Could not turn off notifications.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (permission === "denied") return;

    setBusy(true);
    setError(null);
    const previous = prefs;
    try {
      let nextPermission: OsPermission = permission;
      if (nextPermission !== "granted") {
        nextPermission = await requestOsPermission();
        setPermission(nextPermission);
      }
      if (nextPermission !== "granted") {
        setError(
          nextPermission === "denied"
            ? "Notifications are blocked in device settings."
            : "Notification permission was not granted.",
        );
        await syncInstallation(accessToken, {
          permissionState: nextPermission === "denied" ? "denied" : "prompt",
        });
        return;
      }

      await registerNativePush();
      await syncInstallation(accessToken, { permissionState: "granted" });

      const res = await updateNotificationPreferences(accessToken, transactionalPrefsPatch(true));
      setPrefs(res.preferences);
    } catch {
      setPrefs(previous);
      setError("Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card profile-section" aria-labelledby="profile-notifications-title">
      <h2 id="profile-notifications-title">Notifications</h2>

      <div className="notify-row notify-row--status">
        <div>
          <strong>Class reminders and booking updates</strong>
          <p>{status}</p>
        </div>
        <label className={["notify-switch", toggleDisabled ? "notify-switch--disabled" : "", busy || prefsState === "loading" ? "notify-switch--busy" : ""].filter(Boolean).join(" ")}>
          <input
            type="checkbox"
            role="switch"
            checked={toggleChecked}
            disabled={toggleDisabled}
            aria-label="Class reminders and booking updates"
            aria-busy={busy || prefsState === "loading"}
            onChange={(e) => void onMasterToggle(e.target.checked)}
          />
          <span className="notify-switch__track" aria-hidden="true">
            <span className="notify-switch__thumb" />
          </span>
        </label>
      </div>

      {permission === "denied" ? (
        <button
          type="button"
          className="btn btn--ghost notify-row__manage"
          onClick={() => void openAppNotificationSettings()}
        >
          Open settings
        </button>
      ) : null}

      {!Capacitor.isNativePlatform() ? (
        <p className="profile-section__hint">Push is available in the AMARÉ Android app.</p>
      ) : null}

      {prefsState === "error" ? (
        <button type="button" className="btn btn--ghost notify-row__manage" disabled={busy} onClick={() => void loadPrefs()}>
          Retry
        </button>
      ) : null}

      {error ? <p className="profile-section__hint">{error}</p> : null}
    </section>
  );
}
