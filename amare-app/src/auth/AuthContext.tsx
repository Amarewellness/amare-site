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
import {
  loadStoredAuth,
  clearAuth,
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
  applyAmareTokens: (accessToken: string, refreshToken: string) => void;
  refreshProfile: () => Promise<void>;
  clearError: () => void;
};

function isAccountDeletedAuthError(message: string): boolean {
  return message.includes("account_deleted");
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
  const refreshedOnce = useRef(false);

  useEffect(() => {
    void hydrateAuth().then((next) => {
      setAccessToken(next.accessToken);
      setRefreshToken(next.refreshToken);
      setProfile(next.profile);
      setReady(true);
    });
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!accessToken) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const access = await fetchMemberAccess(accessToken);
      if (!access.signedIn) {
        clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
        return;
      }
      let summary: MemberSummary | null = null;
      if (access.studioAccess === "linked") {
        try {
          summary = await apiJson<MemberSummary>("/api/mindbody/member/summary", accessToken);
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
      const is401 = e instanceof ApiError && e.status === 401;
      const authErr =
        is401 ||
        msg.includes("invalid_bearer") ||
        msg.includes("not_authenticated") ||
        msg.includes("signed_out") ||
        msg.includes("token_refresh") ||
        msg.includes("missing_refresh") ||
        msg.includes("invalid_refresh") ||
        isAccountDeletedAuthError(msg);

      if (isAccountDeletedAuthError(msg)) {
        clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
        return;
      }

      if (authErr && refreshToken && !refreshedOnce.current) {
        try {
          refreshedOnce.current = true;
          const pair = await refreshTokens(refreshToken);
          setAccessToken(pair.accessToken);
          setRefreshToken(pair.refreshToken);
          return;
        } catch {
          clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
          return;
        }
      }

      if (authErr) {
        clearSignedOutState(setAccessToken, setRefreshToken, setProfile, setError);
        return;
      }

      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [accessToken, refreshToken]);

  useEffect(() => {
    if (!ready) return;
    void refreshProfile();
  }, [ready, refreshProfile]);

  const applyAmareTokens = useCallback((nextAccess: string, nextRefresh: string) => {
    refreshedOnce.current = false;
    setAccessToken(nextAccess);
    setRefreshToken(nextRefresh);
    setError(null);
  }, []);

  const clearLocalSession = useCallback(async () => {
    await revokeCurrentInstallation(null);
    clearAuth();
    setAccessToken(null);
    setRefreshToken(null);
    setProfile(null);
    setError(null);
  }, []);

  const signOut = useCallback(async () => {
    await revokeCurrentInstallation(accessToken);
    await revokeSession(accessToken, refreshToken);
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
      isLoggedIn: !!accessToken,
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
