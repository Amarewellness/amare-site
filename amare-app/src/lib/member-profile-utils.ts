import { reconcilePackWithUpcomingVisits } from "./wallet-view";
import { countUpcomingBookedVisits } from "./visit-utils";

export type StripeCommitment = {
  displayName?: string;
  status?: string;
  commitmentEndDate?: string;
  minimumCommitmentMonths?: number;
  mindbodyMembershipTypeId?: number | null;
};

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

export function firstArrayFrom(obj: unknown, keys: string[]): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k];
  }
  const pr = o.PaginationResponse;
  if (pr && typeof pr === "object") {
    for (const k of keys) {
      if (Array.isArray((pr as Record<string, unknown>)[k])) {
        return (pr as Record<string, unknown>)[k] as unknown[];
      }
    }
  }
  return [];
}

export function formatMemberDate(v: unknown): string {
  if (v == null || v === "") return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export function clientServicesFromSummary(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const sum = data as Record<string, unknown>;
  return firstArrayFrom(sum.clientServices, ["ClientServices", "Services", "clientServices"]).filter(
    (x): x is Record<string, unknown> => x != null && typeof x === "object",
  );
}

function isClientServiceExpired(r: Record<string, unknown>): boolean {
  const exp = pick(r, ["ExpirationDate", "expirationDate", "End", "endDate"]);
  if (exp == null || exp === "") return false;
  const d = new Date(String(exp));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return expDay < todayDay;
}

function clientServiceRemainingNum(r: Record<string, unknown>): number | null {
  const remRaw = pick(r, ["Remaining", "remaining"]);
  if (typeof remRaw === "number") return remRaw;
  if (remRaw != null && Number.isFinite(Number(remRaw))) return Number(remRaw);
  return null;
}

export function passesActiveServiceFilter(row: Record<string, unknown>, showAll: boolean): boolean {
  if (showAll) return true;
  if (isClientServiceExpired(row)) return false;
  const rem = clientServiceRemainingNum(row);
  if (rem !== null && rem <= 0) return false;
  return true;
}

export function formatPackVisitsRemaining(r: Record<string, unknown>): string {
  const rem = clientServiceRemainingNum(r);
  const deductedRaw = pick(r, ["NumberDeducted", "numberDeducted", "Visited", "visited"]);
  const deducted =
    typeof deductedRaw === "number"
      ? deductedRaw
      : deductedRaw != null && Number.isFinite(Number(deductedRaw))
        ? Number(deductedRaw)
        : null;
  const totalRaw = pick(r, [
    "TotalPurchased",
    "totalPurchased",
    "PurchasedCount",
    "SessionCount",
    "TotalCount",
    "OriginalTotal",
    "originalTotal",
  ]);
  let total =
    typeof totalRaw === "number"
      ? totalRaw
      : totalRaw != null && Number.isFinite(Number(totalRaw))
        ? Number(totalRaw)
        : null;
  if (total == null && rem != null && rem >= 0 && deducted != null && deducted >= 0) {
    total = rem + deducted;
  }
  if (rem != null && total != null && total > 0) return `${rem} / ${total}`;
  if (rem != null) return String(rem);
  return "—";
}

/** Reconcile primary pack remaining when API lags behind upcoming bookings. */
export function formatPackVisitsRemainingReconciled(
  r: Record<string, unknown>,
  summary: unknown,
  isPrimary: boolean,
): string {
  const base = formatPackVisitsRemaining(r);
  if (!isPrimary || !summary) return base;
  const rem = clientServiceRemainingNum(r);
  if (rem == null) return base;
  const deductedRaw = pick(r, ["NumberDeducted", "numberDeducted", "Visited", "visited"]);
  const deducted =
    typeof deductedRaw === "number"
      ? deductedRaw
      : deductedRaw != null && Number.isFinite(Number(deductedRaw))
        ? Number(deductedRaw)
        : 0;
  let total = rem + (deducted ?? 0);
  if (base.includes("/")) {
    const t = parseInt(base.split("/")[1]?.trim() ?? "", 10);
    if (Number.isFinite(t) && t > 0) total = t;
  }
  if (total <= 0) total = rem;
  const upcoming = countUpcomingBookedVisits(summary);
  const reconciled = reconcilePackWithUpcomingVisits(
    {
      name: String(pick(r, ["Name", "ProgramName"]) ?? "Package"),
      remaining: rem,
      total,
      expiryLabel: "",
      isRecurringMonthly: false,
    },
    upcoming,
  );
  if (reconciled.remaining === rem) return base;
  if (total > 0) return `${reconciled.remaining} / ${total}`;
  return String(reconciled.remaining);
}

export function membershipsFromSummary(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const sum = data as Record<string, unknown>;
  return firstArrayFrom(sum.memberships, [
    "ClientMemberships",
    "Memberships",
    "memberships",
    "ActiveClientMemberships",
    "ActiveMemberships",
    "activeMemberships",
  ]).filter((x): x is Record<string, unknown> => x != null && typeof x === "object");
}

export function stripeCommitmentsFromSummary(data: unknown): StripeCommitment[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as Record<string, unknown>).stripeSubscriptionCommitments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is StripeCommitment => x != null && typeof x === "object");
}

function membershipTypeId(row: Record<string, unknown>): number | null {
  const raw = pick(row, ["MembershipId", "MembershipID", "MembershipTypeId", "ProgramId", "Id"]);
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function findCommitmentForMembership(
  row: Record<string, unknown>,
  commitments: StripeCommitment[],
): StripeCommitment | null {
  const byId = new Map<number, StripeCommitment>();
  for (const c of commitments) {
    if (c.mindbodyMembershipTypeId != null) {
      byId.set(Number(c.mindbodyMembershipTypeId), c);
    }
  }
  const mtId = membershipTypeId(row);
  if (mtId != null && byId.has(mtId)) return byId.get(mtId)!;
  if (commitments.length === 1 && byId.size === 0) return commitments[0];
  return null;
}

export function formatCommitmentCell(c: StripeCommitment | null): string {
  if (!c?.commitmentEndDate) return "—";
  const endMs = Date.parse(c.commitmentEndDate);
  if (Number.isFinite(endMs) && endMs <= Date.now()) return "Commitment fulfilled";
  const dateLabel = formatMemberDate(c.commitmentEndDate);
  const months = c.minimumCommitmentMonths;
  if (typeof months === "number" && months > 0) return dateLabel;
  return dateLabel;
}

export function flattenBalanceRows(balancesRoot: unknown): Record<string, unknown>[] {
  if (!balancesRoot || typeof balancesRoot !== "object") return [];
  let rows = firstArrayFrom(balancesRoot, [
    "AccountBalances",
    "Balances",
    "ClientBalances",
    "BalancesDetails",
    "Clients",
    "clients",
  ]);

  if (rows.length === 1 && rows[0] && typeof rows[0] === "object") {
    const o = rows[0] as Record<string, unknown>;
    if (Array.isArray(o.Accounts) && o.Accounts.length) {
      return o.Accounts.filter((x): x is Record<string, unknown> => x != null && typeof x === "object");
    }
    if (Array.isArray(o.ClientAccountBalances) && o.ClientAccountBalances.length) {
      return o.ClientAccountBalances.filter(
        (x): x is Record<string, unknown> => x != null && typeof x === "object",
      );
    }
    if (Array.isArray(o.Balances) && o.Balances.length) {
      return o.Balances.filter((x): x is Record<string, unknown> => x != null && typeof x === "object");
    }
  }

  return rows.filter((r): r is Record<string, unknown> => {
    if (!r || typeof r !== "object") return false;
    const row = r as Record<string, unknown>;
    if ("Accounts" in row || Array.isArray(row.Balances)) return false;
    return (
      pick(row, ["Description", "Type", "name"]) != null ||
      pick(row, ["AccountBalance", "Balance", "amount", "CurrentBalance"]) != null
    );
  });
}

export function balanceLabel(row: Record<string, unknown>): string {
  const d = pick(row, ["Description", "Type", "name", "ServiceCategoryName"]);
  if (typeof d === "string" && d.trim()) return d.trim();
  if (pick(row, ["AccountBalance", "Balance", "amount", "CurrentBalance"]) != null) {
    return "Account balance";
  }
  return "—";
}

export function balanceAmount(row: Record<string, unknown>): string {
  const raw = pick(row, ["AccountBalance", "Balance", "amount", "CurrentBalance"]);
  return raw != null && raw !== "" ? String(raw) : "—";
}

export function clientField(client: Record<string, unknown> | undefined, keys: string[]): string {
  if (!client) return "";
  for (const k of keys) {
    const v = client[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

export function profileDisplayName(
  client: Record<string, unknown> | undefined,
  sessionName?: string | null,
): string {
  const fn = clientField(client, ["FirstName", "firstName"]);
  const ln = clientField(client, ["LastName", "lastName"]);
  const combined = `${fn} ${ln}`.trim();
  return combined || sessionName || "—";
}
