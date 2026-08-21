import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiJson } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  formatCacheAge,
  readMemberSummaryCache,
  writeMemberSummaryCache,
} from "../lib/member-summary-cache";

type MemberSummaryValue = {
  summary: unknown;
  loading: boolean;
  initialReady: boolean;
  error: string | null;
  cacheNote: string | null;
  reload: (opts?: { silent?: boolean }) => Promise<void>;
};

const MemberSummaryContext = createContext<MemberSummaryValue | null>(null);

export function MemberSummaryProvider({ children }: { children: ReactNode }) {
  const { accessToken, isLoggedIn, loading: authLoading } = useAuth();
  const [summary, setSummary] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [initialReady, setInitialReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!accessToken) {
        setSummary(null);
        setCacheNote(null);
        setError(null);
        return;
      }
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const data = await apiJson<unknown>("/api/mindbody/member/summary", accessToken);
        setSummary(data);
        writeMemberSummaryCache(data);
        setCacheNote(null);
      } catch (e) {
        const cached = readMemberSummaryCache();
        if (cached) {
          setSummary(cached.data);
          setCacheNote(`Showing saved data from ${formatCacheAge(cached.savedAt)}`);
          setError(null);
        } else {
          setError(e instanceof Error ? e.message : "load_failed");
          setSummary(null);
        }
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [accessToken],
  );

  useEffect(() => {
    if (authLoading) {
      setInitialReady(false);
      return;
    }
    if (!isLoggedIn || !accessToken) {
      setSummary(null);
      setCacheNote(null);
      setError(null);
      setLoading(false);
      setInitialReady(true);
      return;
    }
    setInitialReady(false);
    void reload().finally(() => setInitialReady(true));
  }, [authLoading, isLoggedIn, accessToken, reload]);

  const value = useMemo<MemberSummaryValue>(
    () => ({ summary, loading, initialReady, error, cacheNote, reload }),
    [summary, loading, initialReady, error, cacheNote, reload],
  );

  return <MemberSummaryContext.Provider value={value}>{children}</MemberSummaryContext.Provider>;
}

export function useMemberSummary(): MemberSummaryValue {
  const ctx = useContext(MemberSummaryContext);
  if (!ctx) throw new Error("useMemberSummary outside MemberSummaryProvider");
  return ctx;
}
