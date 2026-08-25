/**
 * Durable AMARÉ app session.
 * Native: Keychain / Keystore via @aparajita/capacitor-secure-storage when present.
 * Vite browser: localStorage (not a native app).
 * Never treat WebView localStorage as the production native store.
 */
import { clearPendingMobilePurchase } from "./lib/pending-mobile-purchase";
import { clearAllPurchaseAttemptIds } from "./lib/purchase-attempt";

export type AuthProfile = {
  email: string | null;
  name: string | null;
  clientId: number | null;
  bookingAllowed: boolean | null;
  linkStatus: string | null;
  studioAccess?: string | null;
  sessionKind?: "amare" | "mindbody" | null;
};

const KEY_ACCESS = "amare_access_token";
const KEY_REFRESH = "amare_refresh_token";
const KEY_PROFILE = "amare_profile";
const KEY_PROFILE_TX = "amare_profile_tx";
const KEY_KIND = "amare_session_kind";

export type SessionKind = "amare" | "mindbody";

export type StoredSession = {
  accessToken: string | null;
  refreshToken: string | null;
  profile: AuthProfile | null;
  profileTxToken: string | null;
  sessionKind: SessionKind | null;
};

let memory: StoredSession = {
  accessToken: null,
  refreshToken: null,
  profile: null,
  profileTxToken: null,
  sessionKind: null,
};

let hydrated = false;

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

function webGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function webSet(key: string, value: string) {
  localStorage.setItem(key, value);
}

function webRemove(key: string) {
  localStorage.removeItem(key);
}

function parseProfile(raw: string | null): AuthProfile | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as AuthProfile;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

function parseKind(raw: string | null): SessionKind | null {
  return raw === "amare" || raw === "mindbody" ? raw : null;
}

/** Sync snapshot. After hydrateAuth(), this is the durable session. */
export function loadStoredAuth(): StoredSession {
  if (hydrated || isNativePlatform()) return { ...memory };
  return {
    accessToken: webGet(KEY_ACCESS),
    refreshToken: webGet(KEY_REFRESH),
    profile: parseProfile(webGet(KEY_PROFILE)),
    profileTxToken: webGet(KEY_PROFILE_TX),
    sessionKind: parseKind(webGet(KEY_KIND)),
  };
}

export function loadStoredProfile(): AuthProfile | null {
  return loadStoredAuth().profile;
}

export async function hydrateAuth(): Promise<StoredSession> {
  const secure = await nativeSecure();
  if (secure) {
    const [accessToken, refreshToken, profileRaw, profileTxToken, kindRaw] = await Promise.all([
      secure.get(KEY_ACCESS),
      secure.get(KEY_REFRESH),
      secure.get(KEY_PROFILE),
      secure.get(KEY_PROFILE_TX),
      secure.get(KEY_KIND),
    ]);
    memory = {
      accessToken,
      refreshToken,
      profile: parseProfile(profileRaw),
      profileTxToken,
      sessionKind: parseKind(kindRaw),
    };
  } else {
    if (isNativePlatform()) {
      console.warn("AMARÉ: native secure storage unavailable; session will not persist across restarts.");
    }
    memory = {
      accessToken: webGet(KEY_ACCESS),
      refreshToken: webGet(KEY_REFRESH),
      profile: parseProfile(webGet(KEY_PROFILE)),
      profileTxToken: webGet(KEY_PROFILE_TX),
      sessionKind: parseKind(webGet(KEY_KIND)),
    };
  }
  hydrated = true;
  if (memory.sessionKind === "mindbody" || memory.profile?.sessionKind === "mindbody") {
    clearAuth();
  }
  return { ...memory };
}

async function persist(next: StoredSession) {
  memory = { ...next };
  const secure = await nativeSecure();
  const write = async (key: string, value: string | null) => {
    if (secure) {
      if (value) await secure.set(key, value);
      else await secure.remove(key);
      return;
    }
    if (value) webSet(key, value);
    else webRemove(key);
  };
  await Promise.all([
    write(KEY_ACCESS, next.accessToken),
    write(KEY_REFRESH, next.refreshToken),
    write(KEY_PROFILE, next.profile ? JSON.stringify(next.profile) : null),
    write(KEY_PROFILE_TX, next.profileTxToken),
    write(KEY_KIND, next.sessionKind),
  ]);
}

export function saveAuth(accessToken: string, refreshToken: string, sessionKind?: SessionKind | null) {
  memory = {
    ...memory,
    accessToken,
    refreshToken,
    sessionKind: sessionKind ?? memory.sessionKind,
  };
  void persist(memory);
}

export function saveProfile(profile: AuthProfile) {
  memory = { ...memory, profile };
  void persist(memory);
}

export function saveProfileTxToken(profileTxToken: string | null) {
  memory = { ...memory, profileTxToken };
  void persist(memory);
}

export function saveSessionKind(sessionKind: SessionKind | null) {
  memory = { ...memory, sessionKind };
  void persist(memory);
}

export function clearAuth() {
  memory = {
    accessToken: null,
    refreshToken: null,
    profile: null,
    profileTxToken: null,
    sessionKind: null,
  };
  void persist(memory);
  void clearPendingMobilePurchase();
  clearAllPurchaseAttemptIds();
}

export function currentProfileTxToken(): string | null {
  return memory.profileTxToken ?? loadStoredAuth().profileTxToken;
}

export function peekSessionKind(): SessionKind | null {
  return memory.sessionKind ?? loadStoredAuth().sessionKind;
}
