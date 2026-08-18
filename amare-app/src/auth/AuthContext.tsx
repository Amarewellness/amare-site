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
  peekSessionKind,
  type AuthProfile,
} from "../config";
import { apiJson, ApiError } from "../api/client";
import { exchangeOAuthCode, refreshTokens, revokeSession, startMindbodyOAuth } from "../api/auth";
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
  signInWithMindbody: () => void;
  signOut: () => Promise<void>;
  completeOAuth: (code: string, state: string) => Promise<void>;
  applyAmareTokens: (accessToken: string, refreshToken: string) => void;
  refreshProfile: () => Promise<void>;
  clearError: () => void;
};

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
      try {
        const access = await fetchMemberAccess(accessToken);
        if (access.signedIn) {
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
          return;
        }
      } catch (amareErr) {
        const amareMsg = amareErr instanceof Error ? amareErr.message : "";
        const amare401 = amareErr instanceof ApiError && amareErr.status === 401;
        if (!amare401 && !amareMsg.includes("signed_out") && peekSessionKind() === "amare") {
          throw amareErr;
        }
      }

      const storedProfile = loadStoredAuth().profile;
      const summary = await apiJson<MemberSummary>("/api/mindbody/member/summary", accessToken);
      const blockedLink =
        storedProfile?.linkStatus === "apple_relay_email" ||
        storedProfile?.linkStatus === "ambiguous_studio_client" ||
        storedProfile?.studioAccess === "ambiguous" ||
        storedProfile?.studioAccess === "conflict";
      const hasClient = summary.clientId != null && summary.clientId > 0;
      const next: AuthProfile = {
        email: summary.profile?.sessionEmail ?? storedProfile?.email ?? null,
        name: summary.profile?.sessionName ?? storedProfile?.name ?? null,
        clientId: summary.clientId ?? storedProfile?.clientId ?? null,
        bookingAllowed: blockedLink ? false : storedProfile?.bookingAllowed ?? (hasClient ? true : false),
        linkStatus: blockedLink
          ? storedProfile!.linkStatus
          : hasClient
            ? "ready"
            : storedProfile?.linkStatus ?? "not_associated",
        studioAccess: blockedLink
          ? storedProfile?.studioAccess ?? null
          : hasClient
            ? "linked"
            : storedProfile?.studioAccess ?? null,
        sessionKind: "mindbody",
      };
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
        msg.includes("invalid_refresh");

      if (authErr && refreshToken && !refreshedOnce.current) {
        try {
          refreshedOnce.current = true;
          const pair = await refreshTokens(refreshToken);
          setAccessToken(pair.accessToken);
          setRefreshToken(pair.refreshToken);
          return;
        } catch {
          clearAuth();
          setAccessToken(null);
          setRefreshToken(null);
          setProfile(null);
          setError(null);
          return;
        }
      }

      if (authErr) {
        clearAuth();
        setAccessToken(null);
        setRefreshToken(null);
        setProfile(null);
        setError(null);
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

  const completeOAuth = useCallback(async (code: string, state: string) => {
    setLoading(true);
    setError(null);
    try {
      const pair = await exchangeOAuthCode(code, state);
      setAccessToken(pair.accessToken);
      setRefreshToken(pair.refreshToken);
      if (pair.profile) {
        setProfile({ ...pair.profile, sessionKind: "mindbody" });
        saveProfile({ ...pair.profile, sessionKind: "mindbody" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign_in_failed");
      setLoading(false);
      throw e;
    }
  }, []);

  const applyAmareTokens = useCallback((nextAccess: string, nextRefresh: string) => {
    refreshedOnce.current = false;
    setAccessToken(nextAccess);
    setRefreshToken(nextRefresh);
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
      signInWithMindbody: startMindbodyOAuth,
      signOut,
      completeOAuth,
      applyAmareTokens,
      refreshProfile,
      clearError: () => setError(null),
    }),
    [accessToken, refreshToken, profile, ready, loading, error, completeOAuth, applyAmareTokens, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
