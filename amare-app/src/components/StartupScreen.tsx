import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { useMemberSummary } from "../hooks/useMemberSummary";

export function StartupScreen({
  exiting = false,
  onExited,
}: {
  exiting?: boolean;
  onExited?: () => void;
}) {
  return (
    <div
      className={`app-startup${exiting ? " is-exiting" : ""}`}
      role="status"
      aria-live="polite"
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (exiting && e.propertyName === "opacity") onExited?.();
      }}
    >
      <p className="app-startup__word">AMARÉ</p>
    </div>
  );
}

export function StartupGate({ children }: { children: ReactNode }) {
  const { loading: authLoading, isLoggedIn } = useAuth();
  const { initialReady } = useMemberSummary();
  const startupReady = !authLoading && (!isLoggedIn || initialReady);
  const [exiting, setExiting] = useState(false);
  const [passed, setPassed] = useState(false);

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
      <StartupScreen exiting={exiting} onExited={() => setPassed(true)} />
    </>
  );
}
