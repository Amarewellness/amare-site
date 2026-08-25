import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Capacitor } from "@capacitor/core";
import {
  loadStoredAuth,
  clearAuth,
  saveAuth,
  saveProfile,
  hydrateAuth,
  type AuthProfile,
} from "../config";
import { apiJson, ApiError } from "../api/client";
import { refreshTokens, revokeSession } from "../api/auth";
import { fetchMemberAccess } from "../api/amare-auth";
import { revokeCurrentInstallation } from "../push/push-session";

type MemberSummary = {
  ok?: boolean;
  profile?: { sessionEmail?: string; sessionName?: string };
  clientId?: number | null;
};

type AuthContextValue = {
  accessToken: string | null;
  refreshToken: string | null;
  profile: AuthProfile | null;
  isLoggedIn: boolean;
  loading: boolean;
  error: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  clearLocalSession: () => Promise<void>;
  applyAmareTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  refreshProfile: (opts?: { showLoading?: boolean }) => Promise<void>;
  clearError: () => void;
};

function isAccountDeletedAuthError(message: string): boolean {
  return message.includes("account_deleted");
}

function isConfirmedAuthFailure(message: string, status?: number): boolean {
  if (isAccountDeletedAuthError(message)) return true;
  return (
    status === 401 ||
    message.includes("invalid_bearer") ||
    message.includes("invalid_refresh") ||
    message.includes("missing_refresh") ||
    message.includes("token_revoked") ||
    message.includes("signed_out")
  );
}

const AuthContext = createContext<AuthContextValue | null>(null);

function goToLogin() {
  const here = window.location.pathname + window.location.search;
  const ret = here.startsWith("/login") ? "/" : here;
  const params = new URLSearchParams();
  if (ret && ret !== "/") params.set("return", ret);
  const qs = params.toString();
  window.location.assign(qs ? `/login?${qs}` : "/login");
}

function profileFromAccess(
  access: Awaited<ReturnType<typeof fetchMemberAccess>>,
  summary: MemberSummary | null,
  stored: AuthProfile | null,
): AuthProfile {
  const studioAccess = access.studioAccess || "none";
  const blocked =
    studioAccess === "ambiguous" ||
    studioAccess === "conflict" ||
    studioAccess === "candidate" ||
    studioAccess === "needs_profile";
  const linked = studioAccess === "linked";
  return {
    email: access.email ?? summary?.profile?.sessionEmail ?? stored?.email ?? null,
    name: access.displayName ?? summary?.profile?.sessionName ?? stored?.name ?? null,
    clientId: summary?.clientId ?? stored?.clientId ?? null,
    bookingAllowed: blocked ? false : linked,
    linkStatus: studioAccess,
    studioAccess,
    sessionKind: "amare",
  };
}

function clearSignedOutState(
  setAccessToken: (v: string | null) => void,
  setRefreshToken: (v: string | null) => void,
  setProfile: (v: AuthProfile | null) => void,
  setError: (v: string | null) => void,
) {
  clearAuth();
  setAccessToken(null);
  setRefreshToken(null);
  setProfile(null);
  setError(null);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const stored = loadStoredAuth();
  const [ready, setReady] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(stored.accessToken);
  const [refreshToken, setRefreshToken] = useState<string | null>(stored.refreshToken);
  const [profile, setProfile] = useState<AuthProfile | null>(stored.profile);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accessRef = useRef(accessToken);
  const refreshRef = useRef(refreshToken);
  accessRef.current = accessToken;
  refreshRef.current = refreshToken;

  useEffect(() => {
    void hydrateAuth().then((next) => {
      setAccessToken(next.accessToken);
      setRefreshToken(next.refreshToken);
      setProfile(next.profile);
      setReady(true);
    });
  }, []);

  const refreshProfile = useCallback(async (opts?: { showLoading?: boolean }) => {
    const showLoading = opts?.showLoading === true;
    if (showLoading) setLoading(true);

    let token = accessRef.current;
    let refresh = refreshRef.current;

    if (!token) {
      if (!refresh) setProfile(null);
      if (showLoading) setLoading(false);
      return;
    }

    const applyTokens = (nextAccess: string, nextRefresh: string) => {
      token = nextAccess;
      refresh = nextRefresh;
      accessRef.current = nextAccess;
      refreshRef.current = nextRefresh;
      setAccessToken(nextAccess);
      setRefreshToken(nextRefresh);
    };

    const loadMemberAccess = async (bearer: string) => fetchMemberAccess(bearer);

    try {
      let access = await loadMemberAccess(token);

      if (!access.signedIn && refresh) {
        const pair = await refreshTokens(refresh);
        applyTokens(pair.accessToken, pair.refreshToken);
        access = await loadMemberAccess(pair.accessToken);
      }

      if (!access.signedIn) {
        clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
        return;
      }

      let summary: MemberSummary | null = null;
      if (access.studioAccess === "linked") {
        try {
          summary = await apiJson<MemberSummary>("/api/mindbody/member/summary", token);
        } catch {
          summary = null;
        }
      }
      const next = profileFromAccess(access, summary, loadStoredAuth().profile);
      setProfile(next);
      saveProfile(next);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "profile_load_failed";
      const status = e instanceof ApiError ? e.status : undefined;

      if (isAccountDeletedAuthError(msg)) {
        clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
        return;
      }

      if (isConfirmedAuthFailure(msg, status) && refresh) {
        try {
          const pair = await refreshTokens(refresh);
          applyTokens(pair.accessToken, pair.refreshToken);
          const access = await loadMemberAccess(pair.accessToken);
          if (!access.signedIn) {
            clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
            return;
          }
          let summary: MemberSummary | null = null;
          if (access.studioAccess === "linked") {
            try {
              summary = await apiJson<MemberSummary>("/api/mindbody/member/summary", pair.accessToken);
            } catch {
              summary = null;
            }
          }
          const next = profileFromAccess(access, summary, loadStoredAuth().profile);
          setProfile(next);
          saveProfile(next);
          setError(null);
          return;
        } catch (refreshErr) {
          const refreshMsg = refreshErr instanceof Error ? refreshErr.message : "refresh_failed";
          if (isConfirmedAuthFailure(refreshMsg)) {
            clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
            return;
          }
          setError(refreshMsg);
          return;
        }
      }

      if (isConfirmedAuthFailure(msg, status)) {
        clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
        return;
      }

      setError(msg);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refreshProfile({ showLoading: true });
  }, [ready, refreshProfile]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !ready) return;
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;

    void (async () => {
      const { App } = await import("@capacitor/app");
      if (cancelled) return;
      handle = await App.addListener("appStateChange", ({ isActive }) => {
        if (isActive && accessRef.current) {
          void refreshProfile();
        }
      });
    })();

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [ready, refreshProfile]);

  const applyAmareTokens = useCallback(async (nextAccess: string, nextRefresh: string) => {
    saveAuth(nextAccess, nextRefresh, "amare");
    accessRef.current = nextAccess;
    refreshRef.current = nextRefresh;
    setAccessToken(nextAccess);
    setRefreshToken(nextRefresh);
    setError(null);
    await refreshProfile({ showLoading: true });
  }, [refreshProfile]);

  const clearLocalSession = useCallback(async () => {
    await revokeCurrentInstallation(null);
    clearAuth();
    accessRef.current = null;
    refreshRef.current = null;
    setAccessToken(null);
    setRefreshToken(null);
    setProfile(null);
    setError(null);
  }, []);

  const signOut = useCallback(async () => {
    await revokeCurrentInstallation(accessToken);
    await revokeSession(accessToken, refreshToken);
    accessRef.current = null;
    refreshRef.current = null;
    setAccessToken(null);
    setRefreshToken(null);
    setProfile(null);
    setError(null);
  }, [accessToken, refreshToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      refreshToken,
      profile,
      isLoggedIn: ready && !!accessToken,
      loading: !ready || loading,
      error,
      signIn: goToLogin,
      signOut,
      clearLocalSession,
      applyAmareTokens,
      refreshProfile,
      clearError: () => setError(null),
    }),
    [accessToken, refreshToken, profile, ready, loading, error, applyAmareTokens, signOut, clearLocalSession, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
