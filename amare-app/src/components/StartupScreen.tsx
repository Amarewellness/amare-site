import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { hideNativeSplash } from "../lib/hide-native-splash";

function useStartupStatusLine(opts: {
  authLoading: boolean;
  isLoggedIn: boolean;
  hasStoredSession: boolean;
  initialReady: boolean;
}): string {
  const { authLoading, isLoggedIn, hasStoredSession, initialReady } = opts;
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine === false : false,
  );

  useEffect(() => {
    const sync = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return useMemo(() => {
    if (offline) {
      if (hasStoredSession || isLoggedIn) {
        return "You're offline — loading saved data…";
      }
      return "You're offline — starting AMARÉ…";
    }
    if (authLoading) {
      if (hasStoredSession) return "Restoring your session…";
      return "Starting AMARÉ…";
    }
    if (isLoggedIn && !initialReady) return "Getting your schedule ready…";
    if (!isLoggedIn) return "Welcome to AMARÉ";
    return "Almost ready…";
  }, [authLoading, hasStoredSession, initialReady, isLoggedIn, offline]);
}

export function StartupScreen({
  exiting = false,
  statusLine,
  showProgress = false,
  onExited,
}: {
  exiting?: boolean;
  statusLine?: string;
  showProgress?: boolean;
  onExited?: () => void;
}) {
  return (
    <div
      className={`app-startup${exiting ? " is-exiting" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={!exiting}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (exiting && e.propertyName === "opacity") onExited?.();
      }}
    >
      <div className="app-startup__stack">
        <p className="app-startup__word">AMARÉ</p>
        {showProgress ? (
          <>
            <div className="app-startup__spinner" aria-hidden="true" />
            {statusLine ? <p className="app-startup__status">{statusLine}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function StartupGate({ children }: { children: ReactNode }) {
  const { loading: authLoading, isLoggedIn, accessToken, refreshToken } = useAuth();
  const { initialReady } = useMemberSummary();
  const hasStoredSession = !!(accessToken || refreshToken);
  const startupReady = !authLoading && (!isLoggedIn || initialReady);
  const [exiting, setExiting] = useState(false);
  const [passed, setPassed] = useState(false);
  const [showProgress, setShowProgress] = useState(false);

  const statusLine = useStartupStatusLine({
    authLoading,
    isLoggedIn,
    hasStoredSession,
    initialReady,
  });

  useEffect(() => {
    void hideNativeSplash();
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setShowProgress(true), 320);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!startupReady || passed || exiting) return;
    setExiting(true);
  }, [startupReady, passed, exiting]);

  useEffect(() => {
    if (!exiting || passed) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce) setPassed(true);
  }, [exiting, passed]);

  if (passed) return children;

  return (
    <>
      {startupReady ? children : null}
      <StartupScreen
        exiting={exiting}
        statusLine={statusLine}
        showProgress={showProgress}
        onExited={() => setPassed(true)}
      />
    </>
  );
}
