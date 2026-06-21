import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { loadStoredAuth, clearAuth, saveProfile, loadStoredProfile, type AuthProfile } from "../config";
import { apiJson, ApiError } from "../api/client";
import { exchangeOAuthCode, refreshTokens, revokeSession, startMindbodyOAuth } from "../api/auth";

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
  completeOAuth: (code: string, state: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const stored = loadStoredAuth();
  const [accessToken, setAccessToken] = useState<string | null>(stored.accessToken);
  const [refreshToken, setRefreshToken] = useState<string | null>(stored.refreshToken);
  const [profile, setProfile] = useState<AuthProfile | null>(stored.profile);
  const [loading, setLoading] = useState(!!stored.accessToken);
  const [error, setError] = useState<string | null>(null);

  const refreshProfile = useCallback(async () => {
    if (!accessToken) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const summary = await apiJson<MemberSummary>("/api/mindbody/member/summary", accessToken);
      const stored = loadStoredProfile();
      const blockedLink =
        stored?.linkStatus === "apple_relay_email" ||
        stored?.linkStatus === "ambiguous_studio_client";
      const hasClient = summary.clientId != null && summary.clientId > 0;
      const next: AuthProfile = {
        email: summary.profile?.sessionEmail ?? stored?.email ?? null,
        name: summary.profile?.sessionName ?? stored?.name ?? null,
        clientId: summary.clientId ?? stored?.clientId ?? null,
        bookingAllowed: blockedLink ? false : stored?.bookingAllowed ?? (hasClient ? true : false),
        linkStatus: blockedLink
          ? stored!.linkStatus
          : hasClient
            ? "ready"
            : stored?.linkStatus ?? "not_associated",
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
        msg.includes("token_refresh") ||
        msg.includes("missing_refresh") ||
        msg.includes("invalid_refresh");

      if (authErr && refreshToken) {
        try {
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
    void refreshProfile();
  }, [refreshProfile]);

  const completeOAuth = useCallback(async (code: string, state: string) => {
    setLoading(true);
    setError(null);
    try {
      const pair = await exchangeOAuthCode(code, state);
      setAccessToken(pair.accessToken);
      setRefreshToken(pair.refreshToken);
      if (pair.profile) {
        setProfile(pair.profile);
        saveProfile(pair.profile);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign_in_failed");
      setLoading(false);
      throw e;
    }
  }, []);

  const signOut = useCallback(async () => {
    await revokeSession(accessToken);
    setAccessToken(null);
    setRefreshToken(null);
    setProfile(null);
    setError(null);
  }, [accessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      refreshToken,
      profile,
      isLoggedIn: !!accessToken,
      loading,
      error,
      signIn: startMindbodyOAuth,
      signOut,
      completeOAuth,
      refreshProfile,
      clearError: () => setError(null),
    }),
    [accessToken, refreshToken, profile, loading, error, completeOAuth, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
