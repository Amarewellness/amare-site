import { formatVisitWhen, visitName, visitStaffLabel, visitStatusLabel, type VisitRow } from "../../lib/visit-utils";

type Props = {
  visit: VisitRow;
};

export function PastVisitCard({ visit }: Props) {
  return (
    <article className="my-class-card card my-class-card--past">
      <div className="my-class-card__head my-class-card__head--static">
        <div className="my-class-card__head-text">
          <h2>{visitName(visit)}</h2>
          <p className="card__meta">{formatVisitWhen(visit)}</p>
          <p className="card__meta">
            {visitStaffLabel(visit)}
            {visitStatusLabel(visit) !== "—" ? ` · ${visitStatusLabel(visit)}` : ""}
          </p>
        </div>
      </div>
    </article>
  );
}
