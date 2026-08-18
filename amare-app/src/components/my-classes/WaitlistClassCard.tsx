import { classTitle, staffName } from "../../api/client";
import { classDurationMinutes } from "../../lib/schedule-utils";
import { formatVisitWhen, type VisitRow } from "../../lib/visit-utils";

type Props = {
  cls: Record<string, unknown> | null;
  visit: VisitRow | null;
  classId: number;
  leaveBusy: boolean;
  onLeave: () => void;
};

export function WaitlistClassCard({ cls, visit, classId, leaveBusy, onLeave }: Props) {
  const title = cls ? classTitle(cls) : `Class #${classId}`;
  const instructor = cls ? staffName(cls) : "";
  const duration = cls ? classDurationMinutes(cls) : null;
  const when = visit ? formatVisitWhen(visit) : null;
  const metaParts = [instructor].filter(Boolean);
  if (duration != null) metaParts.push(`${duration} min`);

  return (
    <article className="my-class-card card">
      <div className="my-class-card__head my-class-card__head--static">
        <div className="my-class-card__head-text">
          <h2>{title}</h2>
          <p className="card__meta">{when || "Waitlist"}</p>
          {metaParts.length > 0 ? <p className="card__meta">{metaParts.join(" · ")}</p> : null}
        </div>
      </div>
      <div className="my-class-card__actions">
        <button type="button" className="btn btn--ghost" disabled={leaveBusy} onClick={onLeave}>
          {leaveBusy ? "Leaving…" : "Leave waitlist"}
        </button>
      </div>
    </article>
  );
}
