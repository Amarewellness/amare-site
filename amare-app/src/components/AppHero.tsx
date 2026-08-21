import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useMemberSummary } from "../hooks/useMemberSummary";
import { firstNameFromDisplay } from "../lib/home-stats";
import { profileDisplayName } from "../lib/member-profile-utils";

function markForPath(pathname: string): string {
  if (pathname.startsWith("/schedule")) return "Schedule";
  if (pathname.startsWith("/my-classes")) return "Classes";
  if (pathname.startsWith("/profile")) return "Profile";
  if (pathname.startsWith("/purchase")) return "Pass";
  return "AMARÉ";
}

function homeDaypart(now = new Date()): { label: string; icon: "sun" | "sunset" | "moon" } {
  const h = now.getHours();
  if (h >= 5 && h < 12) return { label: "Good morning", icon: "sun" };
  if (h >= 12 && h < 17) return { label: "Good afternoon", icon: "sun" };
  if (h >= 17 && h < 21) return { label: "Good evening", icon: "sunset" };
  return { label: "Good night", icon: "moon" };
}

function DaypartIcon({ kind }: { kind: "sun" | "sunset" | "moon" }) {
  if (kind === "moon") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M15.2 3.1a8.8 8.8 0 1 0 5.7 14.4A8.2 8.2 0 0 1 15.2 3.1Z" />
      </svg>
    );
  }
  if (kind === "sunset") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M4 17h16v2H4v-2Zm8-11.5A5.5 5.5 0 0 1 17.5 11H6.5A5.5 5.5 0 0 1 12 5.5ZM2 13h3v2H2v-2Zm17 0h3v2h-3v-2Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 7.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6ZM11 2h2v3h-2V2Zm0 17h2v3h-2v-3ZM2 11h3v2H2v-2Zm17 0h3v2h-3v-2Z"
      />
    </svg>
  );
}

export function AppHero() {
  const { pathname } = useLocation();
  const { isLoggedIn, profile } = useAuth();
  const { summary } = useMemberSummary();
  const daypart = homeDaypart();
  const mark = markForPath(pathname);
  const client =
    summary && typeof summary === "object"
      ? ((summary as { profile?: { client?: Record<string, unknown> } }).profile?.client ?? undefined)
      : undefined;
  const first = firstNameFromDisplay(profileDisplayName(client, profile?.name));
  const title = isLoggedIn ? (first ? `Hi, ${first}.` : "Hi there.") : "Welcome.";

  return (
    <header className="app-hero">
      <div className="app-hero__copy">
        <h1 className="app-hero__hello">{title}</h1>
        <p className="app-hero__greet">
          <DaypartIcon kind={daypart.icon} />
          <span>{daypart.label}</span>
        </p>
      </div>
      <div className="app-hero__edge" aria-hidden="true">
        <svg className="app-hero__wave" viewBox="0 0 390 56" preserveAspectRatio="none">
          <path
            className="app-hero__wave-fill"
            d="M0 56 V36 H226 C248 36 282 0 304 0 H390 V56 Z"
          />
          <path
            className="app-hero__wave-dash"
            d="M0 42 H226 C248 42 282 6 304 6 H390"
          />
        </svg>
        <span className="app-hero__mark">{mark}</span>
      </div>
    </header>
  );
}
