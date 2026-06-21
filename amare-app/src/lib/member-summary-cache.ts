const CACHE_KEY = "amare_member_summary_v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type CacheEntry = {
  savedAt: number;
  data: unknown;
};

export function readMemberSummaryCache(): { data: unknown; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed.savedAt !== "number" || parsed.data == null) return null;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return { data: parsed.data, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function writeMemberSummaryCache(data: unknown): void {
  try {
    const entry: CacheEntry = { savedAt: Date.now(), data };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* quota / private mode */
  }
}

export function formatCacheAge(savedAt: number): string {
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr ago`;
  return formatMemberDateShort(savedAt);
}

function formatMemberDateShort(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
