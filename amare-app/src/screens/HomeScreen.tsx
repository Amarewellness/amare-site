import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useBringAFriendStatus } from "../components/bring-a-friend/BringAFriendSection";
import { useMemberSummary } from "../hooks/useMemberSummary";
import {
  classesThisMonthCount,
  creditsLabel,
  firstNameFromDisplay,
  hasReliableFirstVisitContext,
  nextUpcomingVisit,
  planLabel,
  progressLine,
  waitlistCount,
} from "../lib/home-stats";
import { profileDisplayName } from "../lib/member-profile-utils";
import { formatVisitWhen, visitName, visitStaffLabel } from "../lib/visit-utils";

export function HomeScreen() {
  const { isLoggedIn, profile, signIn, accessToken } = useAuth();
  const { summary, loading, error } = useMemberSummary();
  const { status: bafStatus } = useBringAFriendStatus(isLoggedIn ? accessToken : null);
  const showPerks = bafStatus?.eligible === true;

  if (!isLoggedIn) {
    return (
      <div className="home-page">
        <p className="home-page__brand">AMARÉ</p>
        <h1 className="home-page__hello">Welcome to AMARÉ</h1>
        <p className="home-page__sub">Boutique Reformer, Mat, and movement in Hallandale.</p>
        <div className="home-page__actions">
          <button type="button" className="btn" onClick={signIn}>
            Sign in
          </button>
          <Link className="btn btn--ghost" to="/schedule">
            Browse schedule
          </Link>
        </div>
        <div className="home-teasers">
          <Link className="home-teaser" to="/schedule">
            <strong>Class types</strong>
            <span>Reformer, Mat, and more — see what’s on this week.</span>
          </Link>
          <Link className="home-teaser" to="/purchase">
            <strong>Memberships</strong>
            <span>Packages and plans for your rhythm.</span>
          </Link>
        </div>
      </div>
    );
  }

  const client =
    summary && typeof summary === "object"
      ? ((summary as { profile?: { client?: Record<string, unknown> } }).profile?.client ?? undefined)
      : undefined;
  const first = firstNameFromDisplay(profileDisplayName(client, profile?.name));
  const next = nextUpcomingVisit(summary);
  const waitlists = waitlistCount(summary);
  const monthCount = classesThisMonthCount(summary);
  const progress = progressLine(summary);
  const nextWhen = next ? formatVisitWhen(next) : "—";

  return (
    <div className="home-page">
      <p className="home-page__brand">AMARÉ</p>
      <h1 className="home-page__hello">{first ? `Hi, ${first}.` : "Hi there."}</h1>
      <p className="home-page__sub">Ready for your next class?</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="home-stats" aria-busy={loading && !summary}>
        <div className="home-stat">
          <span className="home-stat__label">Credits</span>
          <span className="home-stat__value">{loading && !summary ? "…" : creditsLabel(summary)}</span>
        </div>
        <div className="home-stat">
          <span className="home-stat__label">Plan</span>
          <span className="home-stat__value home-stat__value--text">
            {loading && !summary ? "…" : planLabel(summary)}
          </span>
        </div>
        <div className="home-stat">
          <span className="home-stat__label">This month</span>
          <span className="home-stat__value">{loading && !summary ? "…" : monthCount}</span>
        </div>
      </div>

      <section className="card home-next">
        {next ? (
          <>
            <h2>Your next class</h2>
            <p className="home-next__when">{nextWhen}</p>
            <p className="home-next__name">{visitName(next)}</p>
            <p className="card__meta">{visitStaffLabel(next)}</p>
            <Link className="btn" to="/my-classes?section=upcoming">
              View in My Classes
            </Link>
          </>
        ) : waitlists > 0 ? (
          <>
            <h2>Waitlist</h2>
            <p className="card__meta">
              You’re on {waitlists} waitlist{waitlists === 1 ? "" : "s"}. We’ll email you if a spot opens.
            </p>
            <Link className="btn" to="/my-classes?section=waitlist">
              View waitlist
            </Link>
          </>
        ) : (
          <>
            <h2>You’re all set</h2>
            <p className="card__meta">Book your next class when you’re ready.</p>
            <Link className="btn" to="/schedule">
              Book a class
            </Link>
          </>
        )}
      </section>

      <div className="home-page__actions">
        <Link className="btn" to="/schedule">
          Book a class
        </Link>
        <div className="home-page__actions-row">
          <Link className="btn btn--ghost" to="/my-classes?section=upcoming">
            My classes
          </Link>
          <Link className="btn btn--ghost" to="/purchase">
            Buy a pass
          </Link>
        </div>
        {showPerks ? (
          <Link className="home-perk-link" to="/my-classes?section=upcoming">
            Bring a friend
          </Link>
        ) : null}
      </div>

      {progress ? <p className="home-progress">{progress}</p> : null}

      {hasReliableFirstVisitContext(summary) ? (
        <p className="home-studio-note">Arrive a few minutes early for your first class.</p>
      ) : null}
    </div>
  );
}
