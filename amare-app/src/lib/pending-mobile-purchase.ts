import {
  sanitizePendingMobilePurchase,
  type PendingMobilePurchase,
} from "./purchase-recovery";

const KEY = "amare_pending_mobile_purchase";

let memory: PendingMobilePurchase | null = null;

function isNativePlatform(): boolean {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

type SecureApi = {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  remove: (key: string) => Promise<void>;
};

async function nativeSecure(): Promise<SecureApi | null> {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import("@aparajita/capacitor-secure-storage");
    const store = mod.SecureStorage;
    if (!store?.setItem || !store?.getItem || !store?.removeItem) return null;
    return {
      set: (key, value) => store.setItem(key, value),
      get: async (key) => {
        try {
          const v = await store.getItem(key);
          return typeof v === "string" && v ? v : null;
        } catch {
          return null;
        }
      },
      remove: (key) => store.removeItem(key).catch(() => undefined),
    };
  } catch {
    return null;
  }
}

function parsePending(raw: string | null): PendingMobilePurchase | null {
  if (!raw) return null;
  try {
    return sanitizePendingMobilePurchase(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function peekPendingMobilePurchase(): PendingMobilePurchase | null {
  return memory;
}

export async function loadPendingMobilePurchase(): Promise<PendingMobilePurchase | null> {
  const secure = await nativeSecure();
  if (secure) {
    memory = parsePending(await secure.get(KEY));
    return memory;
  }
  try {
    memory = parsePending(localStorage.getItem(KEY));
  } catch {
    memory = null;
  }
  return memory;
}

export async function savePendingMobilePurchase(next: PendingMobilePurchase): Promise<void> {
  const safe = sanitizePendingMobilePurchase(next);
  if (!safe) return;
  memory = safe;
  const raw = JSON.stringify(safe);
  const secure = await nativeSecure();
  if (secure) {
    await secure.set(KEY, raw);
    return;
  }
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    /* in-memory still holds the same-process pointer */
  }
}

export async function clearPendingMobilePurchase(): Promise<void> {
  memory = null;
  const secure = await nativeSecure();
  if (secure) {
    await secure.remove(KEY);
    return;
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
