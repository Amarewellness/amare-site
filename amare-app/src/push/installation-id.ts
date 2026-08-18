const KEY = "amare_push_installation_id";

function isNativePlatform(): boolean {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

type SecureKv = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

async function nativeSecure(): Promise<SecureKv | null> {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import("@aparajita/capacitor-secure-storage");
    const store = mod.SecureStorage;
    if (typeof store?.getItem !== "function" || typeof store?.setItem !== "function") return null;
    // Wrap the plugin: Capacitor plugins are thenable, so returning them from
    // async functions throws SecureStorage.then() on Android.
    return {
      getItem: (key) => store.getItem(key),
      setItem: (key, value) => store.setItem(key, value),
    };
  } catch {
    return null;
  }
}

function newId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `ins_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

let cachedId: string | null = null;
let inflight: Promise<string> | null = null;

async function readOrCreateInstallationId(): Promise<string> {
  const secure = await nativeSecure();
  if (secure) {
    try {
      const existing = await secure.getItem(KEY);
      if (typeof existing === "string" && existing.startsWith("ins_")) return existing;
    } catch {
      /* create */
    }
    const id = newId();
    await secure.setItem(KEY, id);
    return id;
  }
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.startsWith("ins_")) return existing;
    const id = newId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return newId();
  }
}

export async function getOrCreateInstallationId(): Promise<string> {
  if (cachedId) return cachedId;
  if (inflight) return inflight;
  inflight = readOrCreateInstallationId()
    .then((id) => {
      cachedId = id;
      return id;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
