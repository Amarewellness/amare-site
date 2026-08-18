import { safeAppReturnPath } from "../config";

let pending: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setPendingPushDestination(raw: string | null | undefined): string {
  const path = safeAppReturnPath(raw);
  pending = path;
  emit();
  return path;
}

export function peekPendingPushDestination(): string | null {
  return pending;
}

export function subscribePendingPushDestination(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function resetPendingPushDestinationForTests(): void {
  pending = null;
}

export function loginPathForSafeReturn(safePath: string): string {
  return `/login?return=${encodeURIComponent(safePath)}`;
}

export type PendingPushDecision =
  | { kind: "wait" }
  | { kind: "idle" }
  | { kind: "navigate"; to: string };

/**
 * Consume at most one pending destination after the router is mounted
 * and mobile session restoration has resolved. Callers must not invoke
 * this until those gates are known. A wait result leaves pending intact.
 */
export function takePendingPushNavigation(opts: {
  routerReady: boolean;
  authResolved: boolean;
  signedIn: boolean;
}): PendingPushDecision {
  if (!pending) return { kind: "idle" };
  if (!opts.routerReady || !opts.authResolved) return { kind: "wait" };
  const path = pending;
  pending = null;
  emit();
  if (opts.signedIn) return { kind: "navigate", to: path };
  return { kind: "navigate", to: loginPathForSafeReturn(path) };
}
