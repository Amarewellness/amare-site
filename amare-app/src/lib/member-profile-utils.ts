import { dateKeyEt } from "./schedule-utils";
import { formatPackCreditsLeft } from "./wallet-view";

/** Mindbody monthly membership ProductIds (front-desk + Stripe). */
export const MONTHLY_MEMBERSHIP_PRODUCT_IDS = new Set([
  100129, 100130, 100056, 100133, 100134, 100135,
]);

export const ACTIVE_MONTHLY_MEMBERSHIP_COPY =
  "You already have an active monthly membership. Please contact the studio if you’d like to change your plan.";

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
  return formatPackCreditsLeft(r, null, false);
}

/** Same remaining as the wallet when this is the primary pack. */
export function formatPackVisitsRemainingReconciled(
  r: Record<string, unknown>,
  summary: unknown,
  isPrimary: boolean,
): string {
  return formatPackCreditsLeft(r, summary, isPrimary);
}

function studioDayKey(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const ymd = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (ymd) return ymd[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return dateKeyEt(d.getTime());
}

export function monthlyProductIdFromRow(row: Record<string, unknown>): number | null {
  const raw = pick(row, ["ProductId", "productId", "ServiceId", "serviceId"]);
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const id = Math.trunc(n);
  return MONTHLY_MEMBERSHIP_PRODUCT_IDS.has(id) ? id : null;
}

export function looksLikeMonthlyMembershipName(row: Record<string, unknown>): boolean {
  const name = String(
    pick(row, ["MembershipName", "Name", "name", "ProgramName", "Description"]) || "",
  )
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (!name) return false;
  return (
    /\bmonthly\b/.test(name) ||
    /\brecurring\b/.test(name) ||
    /\bunlimited\b/.test(name) ||
    /\b\d+\s+monthly\s+classes?\b/.test(name)
  );
}

export function isRecognizedMonthlyMembershipRow(row: Record<string, unknown>): boolean {
  return monthlyProductIdFromRow(row) != null || looksLikeMonthlyMembershipName(row);
}

/** Paid membership window in America/New_York. Ignores Remaining / Current / Active. */
export function monthlyMembershipWindowActive(
  row: Record<string, unknown>,
  nowMs = Date.now(),
): boolean {
  const start = studioDayKey(pick(row, ["ActiveDate", "activeDate"]));
  const end = studioDayKey(pick(row, ["ExpirationDate", "expirationDate", "EndDate", "End", "endDate"]));
  const today = dateKeyEt(nowMs);
  if (!end) return false;
  if (start && today < start) return false;
  return today <= end;
}

export function formatMembershipActive(row: Record<string, unknown>, nowMs = Date.now()): string {
  if (isRecognizedMonthlyMembershipRow(row)) {
    return monthlyMembershipWindowActive(row, nowMs) ? "Yes" : "No";
  }
  const flag = pick(row, ["Active", "active", "Current", "current", "IsActive", "isActive"]);
  if (typeof flag === "boolean") return flag ? "Yes" : "No";
  if (flag === 1 || flag === "1" || flag === "true" || flag === "True") return "Yes";
  if (flag === 0 || flag === "0" || flag === "false" || flag === "False") return "No";
  const exp = pick(row, ["ExpirationDate", "EndDate", "end"]);
  if (exp != null && exp !== "") {
    const d = new Date(String(exp));
    if (!Number.isNaN(d.getTime())) {
      const endDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const today = new Date();
      const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      return endDay >= todayDay ? "Yes" : "No";
    }
  }
  return "—";
}

export function hasActiveMonthlyMembership(summary: unknown, nowMs = Date.now()): boolean {
  const rows = [...membershipsFromSummary(summary), ...clientServicesFromSummary(summary)];
  return rows.some(
    (row) => isRecognizedMonthlyMembershipRow(row) && monthlyMembershipWindowActive(row, nowMs),
  );
}

export function hostedCheckoutFailureMessage(
  data: { error?: unknown; message?: unknown } | null | undefined,
  status: number,
): string {
  const error = typeof data?.error === "string" ? data.error : "";
  const message = typeof data?.message === "string" ? data.message.trim() : "";
  if (error === "subscription_already_active" || /already have an active .* monthly membership/i.test(message)) {
    return ACTIVE_MONTHLY_MEMBERSHIP_COPY;
  }
  if (message) return message;
  if (error) return error;
  return `create_session_${status}`;
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

/** Mindbody `AccountBalance` is studio currency (USD here), not class visits. */
export function parseBalanceAmount(row: Record<string, unknown>): number | null {
  const raw = pick(row, ["AccountBalance", "Balance", "amount", "CurrentBalance"]);
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function formatUsdAccountBalance(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export function balanceAmount(row: Record<string, unknown>): string {
  const n = parseBalanceAmount(row);
  return n == null ? "—" : formatUsdAccountBalance(n);
}

export function hasDisplayableAccountCredit(rows: Record<string, unknown>[]): boolean {
  return rows.some((row) => {
    const n = parseBalanceAmount(row);
    return n != null && n !== 0;
  });
}

export function clientField(client: Record<string, unknown> | undefined, keys: string[]): string {
  if (!client) return "";
  for (const k of keys) {
    const v = client[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

export function capitalizePersonName(name: string): string {
  const t = String(name || "").trim();
  if (!t || t === "—") return t;
  return t.replace(/(\p{L})(\p{L}*)/gu, (_, first: string, rest: string) => first.toLocaleUpperCase() + rest);
}

export function profileDisplayName(
  client: Record<string, unknown> | undefined,
  sessionName?: string | null,
): string {
  const fn = clientField(client, ["FirstName", "firstName"]);
  const ln = clientField(client, ["LastName", "lastName"]);
  const combined = `${fn} ${ln}`.trim();
  return capitalizePersonName(combined || sessionName || "—");
}
