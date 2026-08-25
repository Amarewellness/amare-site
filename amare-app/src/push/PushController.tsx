import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { pathFromNotificationData } from "../lib/push-path";
import {
  peekPendingPushDestination,
  setPendingPushDestination,
  subscribePendingPushDestination,
  takePendingPushNavigation,
} from "./pending-destination";
import { fetchNotificationPreferences, isTransactionalPushEnabled } from "../api/notifications";
import { isAmarePushClientEnabled } from "./push-flags";
import { bootstrapPushArrival } from "./push-arrival";
import { currentOsPermission, registerNativePush, requestOsPermission, syncInstallation } from "./push-session";

const PUSH_BANNER_AUTO_DISMISS_MS = 4500;
const PUSH_BANNER_EXIT_MS = 320;

export function PushController({ children }: { children: ReactNode }) {
  if (!isAmarePushClientEnabled()) return children;
  return <PushControllerLive>{children}</PushControllerLive>;
}

function PushControllerLive({ children }: { children: ReactNode }) {
  const { accessToken, isLoggedIn, loading } = useAuth();
  const navigate = useNavigate();
  const fcmTokenRef = useRef<string | null>(null);
  const accessRef = useRef<string | null>(accessToken);
  const dismissTimersRef = useRef<number[]>([]);
  const [banner, setBanner] = useState<{ title: string; body: string; path: string } | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerExiting, setBannerExiting] = useState(false);
  const [pendingRev, setPendingRev] = useState(0);
  accessRef.current = accessToken;

  const clearDismissTimers = useCallback(() => {
    for (const id of dismissTimersRef.current) window.clearTimeout(id);
    dismissTimersRef.current = [];
  }, []);

  const dismissBanner = useCallback(
    (onDone?: () => void) => {
      clearDismissTimers();
      setBannerExiting(true);
      setBannerVisible(false);
      const removeId = window.setTimeout(() => {
        setBanner(null);
        setBannerExiting(false);
        onDone?.();
      }, PUSH_BANNER_EXIT_MS);
      dismissTimersRef.current.push(removeId);
    },
    [clearDismissTimers],
  );

  useEffect(() => {
    if (!banner) {
      setBannerVisible(false);
      setBannerExiting(false);
      return;
    }

    setBannerExiting(false);
    setBannerVisible(false);
    const enterId = window.requestAnimationFrame(() => {
      setBannerVisible(true);
    });

    const autoDismissId = window.setTimeout(() => {
      dismissBanner();
    }, PUSH_BANNER_AUTO_DISMISS_MS);
    dismissTimersRef.current.push(autoDismissId);

    return () => {
      window.cancelAnimationFrame(enterId);
      clearDismissTimers();
    };
  }, [banner, clearDismissTimers, dismissBanner]);

  useEffect(() => {
    bootstrapPushArrival();
    const unsub = subscribePendingPushDestination(() => setPendingRev((n) => n + 1));
    if (peekPendingPushDestination()) setPendingRev((n) => n + 1);
    return unsub;
  }, []);

  useEffect(() => {
    const decision = takePendingPushNavigation({
      routerReady: true,
      authResolved: !loading,
      signedIn: isLoggedIn,
    });
    if (decision.kind !== "navigate") return;
    navigate(decision.to, { replace: true });
  }, [loading, isLoggedIn, navigate, pendingRev]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    const handles: { remove: () => Promise<void> }[] = [];

    void (async () => {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      if (cancelled) return;

      const reg = await PushNotifications.addListener("registration", (token) => {
        fcmTokenRef.current = token.value;
        const access = accessRef.current;
        if (access) {
          void syncInstallation(access, { pushToken: token.value, permissionState: "granted" });
        }
      });
      const err = await PushNotifications.addListener("registrationError", () => {
        /* keep UI on current permission state */
      });
      const received = await PushNotifications.addListener("pushNotificationReceived", (notification) => {
        const path = pathFromNotificationData(notification.data as Record<string, unknown>);
        setBanner({
          title: notification.title || "AMARÉ",
          body: notification.body || "",
          path,
        });
      });
      handles.push(reg, err, received);
    })();

    return () => {
      cancelled = true;
      for (const h of handles) void h.remove();
    };
  }, []);

  useEffect(() => {
    if (loading || !isLoggedIn || !accessToken || !Capacitor.isNativePlatform()) return;
    void (async () => {
      try {
        const res = await fetchNotificationPreferences(accessToken);
        if (!isTransactionalPushEnabled(res.preferences)) return;
      } catch {
        return;
      }

      let permission = await currentOsPermission();
      if (permission !== "granted" && permission !== "denied") {
        permission = await requestOsPermission();
      }
      if (permission !== "granted") {
        await syncInstallation(accessToken, { permissionState: permission, pushToken: fcmTokenRef.current });
        return;
      }
      await registerNativePush();
      if (fcmTokenRef.current) {
        await syncInstallation(accessToken, { pushToken: fcmTokenRef.current, permissionState: "granted" });
      }
    })();
  }, [loading, isLoggedIn, accessToken]);

  return (
    <>
      {children}
      {banner ? (
        <button
          type="button"
          className={[
            "push-banner",
            bannerVisible && !bannerExiting ? "push-banner--visible" : "",
            bannerExiting ? "push-banner--exit" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            dismissBanner(() => {
              setPendingPushDestination(pathFromNotificationData({ path: banner.path }));
            });
          }}
        >
          <strong>{banner.title}</strong>
          {banner.body ? <span>{banner.body}</span> : null}
        </button>
      ) : null}
    </>
  );
}
