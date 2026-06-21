import { ApiError } from "./client";

export type BookFailure = {
  message: string;
  suggestPackages: boolean;
  paymentMismatch: boolean;
  noLongerAvailable: boolean;
  classFull: boolean;
  clientNotLinked: boolean;
};

function mindbodyMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const j = body as Record<string, unknown>;
  const mb = j.mindbody;
  if (mb && typeof mb === "object") {
    const d = mb as Record<string, unknown>;
    const inner = d.Error && typeof d.Error === "object" ? (d.Error as { Message?: string }) : null;
    if (inner?.Message) return inner.Message;
    if (typeof d.Message === "string") return d.Message;
  }
  if (typeof j.detail === "string") return j.detail;
  return "";
}

function interpretMessage(raw: string): { message: string; suggestPackages: boolean; paymentMismatch: boolean } {
  const s = raw.trim();
  if (!s) return { message: "Booking didn't complete.", suggestPackages: false, paymentMismatch: false };
  if (
    /\bno\s+available\s+payments?\b/i.test(s) ||
    /\bhas\s+no\s+available\s+payments?\b/i.test(s) ||
    /ClassRequiresPayment/i.test(s)
  ) {
    return {
      message:
        "Mindbody couldn't apply your package to this class. Your credits may not cover this class type, or the pass may not be valid for this date. Try another class or contact the studio.",
      suggestPackages: false,
      paymentMismatch: true,
    };
  }
  return { message: s, suggestPackages: false, paymentMismatch: false };
}

export function parseBookFailure(err: unknown): BookFailure {
  const base: BookFailure = {
    message: "Booking failed.",
    suggestPackages: false,
    paymentMismatch: false,
    noLongerAvailable: false,
    classFull: false,
    clientNotLinked: false,
  };

  if (!(err instanceof ApiError)) {
    return { ...base, message: err instanceof Error ? err.message : base.message };
  }

  const body = err.body;
  const errCode =
    body && typeof body === "object" && "error" in body ? String((body as { error: string }).error) : "";

  if (errCode === "client_not_linked") {
    return {
      ...base,
      clientNotLinked: true,
      message:
        "We couldn't link your Mindbody sign-in to your AMARÉ studio profile. Sign in with your studio email, or buy a pass on Pricing first.",
      suggestPackages: true,
    };
  }

  const raw = mindbodyMessage(body) || err.message;
  const classFull = /\bfull\b|\bcapacity\b/i.test(raw);
  const noLongerAvailable =
    classFull || /\bno longer available\b/i.test(raw) || /\binvalid class\b/i.test(raw);

  if (noLongerAvailable) {
    return {
      ...base,
      noLongerAvailable: true,
      classFull,
      message: classFull
        ? "This class is full. You can join the waitlist or pick another time."
        : "This class is no longer available. Refresh the schedule and try another class.",
    };
  }

  const { message, suggestPackages, paymentMismatch } = interpretMessage(raw || errCode || err.message);
  return { ...base, message, suggestPackages: suggestPackages || err.status === 401, paymentMismatch };
}
