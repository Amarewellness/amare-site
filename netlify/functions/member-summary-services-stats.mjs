// @ts-check
/**
 * Derive wallet-aligned ClientService stats for member-summary observability.
 * Pure computation — no logging.
 */

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

/** @param {unknown} data */
export function clientServicesRowsFromPayload(data) {
  if (!data || typeof data !== "object") return [];
  const d = /** @type {Record<string, unknown>} */ (data);
  for (const k of ["ClientServices", "clientServices", "Services", "services"]) {
    const v = d[k];
    if (Array.isArray(v)) {
      return v.filter((x) => x && typeof x === "object").map((x) => /** @type {Record<string, unknown>} */ (x));
    }
  }
  return [];
}

/** @param {Record<string, unknown>} r */
function clientServiceRemaining(r) {
  const remRaw = pick(r, ["Remaining", "remaining"]);
  if (typeof remRaw === "number" && Number.isFinite(remRaw)) return remRaw;
  if (remRaw != null && Number.isFinite(Number(remRaw))) return Number(remRaw);
  return null;
}

/** @param {Record<string, unknown>} r */
function isExpired(r) {
  const exp = pick(r, ["ExpirationDate", "expirationDate", "End", "endDate"]);
  if (exp == null || exp === "") return false;
  const d = new Date(String(exp));
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  const expDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return expDay < todayDay;
}

/** @param {Record<string, unknown>} r */
function isInactive(r) {
  const active = pick(r, ["Active", "active", "IsActive", "isActive", "Current", "current"]);
  return active === false || active === "false" || active === 0 || active === "0";
}

/** @param {string} name */
function isMonthlyMembershipPack(name) {
  return typeof name === "string" && /\bmonthly\b/i.test(name);
}

/** @param {Record<string, unknown>} r */
function recencyMs(r) {
  const exp = pick(r, ["ExpirationDate", "expirationDate", "End", "endDate"]);
  const expMs = exp != null && exp !== "" ? new Date(String(exp)).getTime() : 0;
  const active = pick(r, ["ActiveDate", "activeDate", "PaymentDate", "paymentDate", "SaleDate", "saleDate"]);
  const activeMs = active != null && active !== "" ? new Date(String(active)).getTime() : 0;
  const idRaw = pick(r, ["Id", "id"]);
  const idNum =
    typeof idRaw === "number" && Number.isFinite(idRaw)
      ? idRaw
      : typeof idRaw === "string" && /^\d+$/.test(idRaw.trim())
        ? parseInt(idRaw.trim(), 10)
        : 0;
  const safeExp = Number.isFinite(expMs) ? expMs : 0;
  const safeActive = Number.isFinite(activeMs) ? activeMs : 0;
  return safeExp * 1_000_000 + safeActive * 1_000 + idNum;
}

/** @param {Record<string, unknown>[]} rows */
function dedupeMonthlyClientServices(rows) {
  /** @type {Map<string, Record<string, unknown>>} */
  const bestMonthly = new Map();
  /** @type {Record<string, unknown>[]} */
  const other = [];
  for (const r of rows) {
    const nameRaw = pick(r, ["Name", "ProgramName", "serviceName"]);
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Package";
    if (!isMonthlyMembershipPack(name)) {
      other.push(r);
      continue;
    }
    const key = name.toLowerCase().replace(/\s+/g, " ").trim();
    const cur = bestMonthly.get(key);
    if (!cur || recencyMs(r) > recencyMs(cur)) bestMonthly.set(key, r);
  }
  return [...other, ...bestMonthly.values()];
}

/** @param {unknown} purchasesPayload */
function refundMatchKeysFromPurchases(purchasesPayload) {
  /** @type {Set<string>} */
  const keys = new Set();
  if (!purchasesPayload || typeof purchasesPayload !== "object") return keys;

  const root = /** @type {Record<string, unknown>} */ (purchasesPayload);
  /** @type {unknown[]} */
  let purchases = [];
  for (const k of ["Purchases", "purchases", "ClientPurchases", "clientPurchases"]) {
    if (Array.isArray(root[k])) {
      purchases = root[k];
      break;
    }
  }

  for (const raw of purchases) {
    if (!raw || typeof raw !== "object") continue;
    const purchase = /** @type {Record<string, unknown>} */ (raw);
    /** @type {unknown[]} */
    let items = [];
    for (const k of ["PurchasedItems", "purchasedItems", "Items", "items"]) {
      if (Array.isArray(purchase[k])) {
        items = purchase[k];
        break;
      }
    }
    for (const itemRaw of items) {
      if (!itemRaw || typeof itemRaw !== "object") continue;
      const item = /** @type {Record<string, unknown>} */ (itemRaw);
      const amount =
        typeof item.TotalAmount === "number"
          ? item.TotalAmount
          : typeof item.totalAmount === "number"
            ? item.totalAmount
            : typeof item.AmountPaid === "number"
              ? item.AmountPaid
              : typeof item.amountPaid === "number"
                ? item.amountPaid
                : null;
      const qty =
        typeof item.Quantity === "number"
          ? item.Quantity
          : typeof item.quantity === "number"
            ? item.quantity
            : null;
      const isRefund = (amount != null && amount < 0) || (qty != null && qty < 0);
      if (!isRefund) continue;

      const nameRaw = item.Name ?? item.name ?? item.Description ?? item.description;
      if (typeof nameRaw === "string" && nameRaw.trim()) {
        keys.add(nameRaw.trim().toLowerCase().replace(/\s+/g, " "));
      }
      const pid = item.ProductId ?? item.productId ?? item.Id ?? item.id;
      if (pid != null && pid !== "") keys.add(`pid:${String(pid)}`);
    }
  }
  return keys;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Set<string>} refundKeys
 */
function isReturnedRefunded(row, refundKeys) {
  if (refundKeys.size === 0) return false;
  const nameRaw = pick(row, ["Name", "ProgramName", "serviceName"]);
  const name = typeof nameRaw === "string" ? nameRaw.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (name && refundKeys.has(name)) return true;
  const pid = pick(row, ["ProductId", "productId", "Id", "id"]);
  if (pid != null && refundKeys.has(`pid:${String(pid)}`)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Set<string>} refundKeys
 * @returns {"expired" | "returned_refunded" | "inactive" | "no_remaining" | null}
 */
function primaryExclusionReason(row, refundKeys) {
  if (isExpired(row)) return "expired";
  if (isReturnedRefunded(row, refundKeys)) return "returned_refunded";
  if (isInactive(row)) return "inactive";
  const rem = clientServiceRemaining(row);
  if (rem == null || rem <= 0) return "no_remaining";
  return null;
}

/** @param {unknown} membershipsPayload */
function hasActiveMembership(membershipsPayload) {
  if (!membershipsPayload || typeof membershipsPayload !== "object") return false;
  const root = /** @type {Record<string, unknown>} */ (membershipsPayload);
  /** @type {unknown[]} */
  let mems = [];
  for (const k of [
    "ClientMemberships",
    "Memberships",
    "memberships",
    "ActiveClientMemberships",
    "ActiveMemberships",
    "activeMemberships",
  ]) {
    if (Array.isArray(root[k])) {
      mems = root[k];
      break;
    }
  }
  return mems.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const m = /** @type {Record<string, unknown>} */ (raw);
    const a = m.Active ?? m.active;
    return a === true || a === "true" || a === 1;
  });
}

/**
 * @param {unknown} clientServicesPayload
 * @param {unknown} membershipsPayload
 * @param {unknown} purchasesPayload
 */
export function computeMemberSummaryServiceStats(
  clientServicesPayload,
  membershipsPayload,
  purchasesPayload,
) {
  const rows = clientServicesRowsFromPayload(clientServicesPayload);
  const refundKeys = refundMatchKeysFromPurchases(purchasesPayload);

  /** @type {{ expired: number; returned_refunded: number; inactive: number; no_remaining: number }} */
  const excludedReasons = {
    expired: 0,
    returned_refunded: 0,
    inactive: 0,
    no_remaining: 0,
  };

  /** @type {Record<string, unknown>[]} */
  const activeRows = [];

  for (const row of rows) {
    const reason = primaryExclusionReason(row, refundKeys);
    if (reason) excludedReasons[reason] += 1;
    else activeRows.push(row);
  }

  const bookableRows = dedupeMonthlyClientServices(activeRows);
  let remainingTotal = 0;
  for (const row of bookableRows) {
    const rem = clientServiceRemaining(row);
    if (rem != null && rem > 0) remainingTotal += rem;
  }

  const activeMembership = hasActiveMembership(membershipsPayload);
  const bookableServiceCount = bookableRows.length;

  return {
    totalServiceCount: rows.length,
    activeServiceCount: activeRows.length,
    bookableServiceCount,
    bookableCredits: bookableServiceCount,
    remainingTotal,
    excludedReasons,
    hasActiveMembership: activeMembership,
    walletBookable: bookableServiceCount > 0 || activeMembership,
  };
}
