import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { bootstrapPushArrival } from "./push-arrival";
import { currentOsPermission, registerNativePush, syncInstallation } from "./push-session";

export function PushController({ children }: { children: ReactNode }) {
  const { accessToken, isLoggedIn, loading } = useAuth();
  const navigate = useNavigate();
  const fcmTokenRef = useRef<string | null>(null);
  const accessRef = useRef<string | null>(accessToken);
  const [banner, setBanner] = useState<{ title: string; body: string; path: string } | null>(null);
  const [pendingRev, setPendingRev] = useState(0);
  accessRef.current = accessToken;

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
      const permission = await currentOsPermission();
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
          className="push-banner"
          onClick={() => {
            setPendingPushDestination(pathFromNotificationData({ path: banner.path }));
            setBanner(null);
          }}
        >
          <strong>{banner.title}</strong>
          {banner.body ? <span>{banner.body}</span> : null}
        </button>
      ) : null}
    </>
  );
}
