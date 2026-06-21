import { useState } from "react";
import { classTitle, staffName } from "../../api/client";
import { classDetailsHtml, classDurationMinutes } from "../../lib/schedule-utils";
import { formatVisitWhen, type VisitRow } from "../../lib/visit-utils";

type Props = {
  visit: VisitRow;
  cls: Record<string, unknown>;
  cancelBusy: boolean;
  onCancel: () => void;
  showInviteGuest?: boolean;
  onInviteGuest?: () => void;
};

export function MyClassVisitCard({
  visit,
  cls,
  cancelBusy,
  onCancel,
  showInviteGuest,
  onInviteGuest,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const detailsHtml = classDetailsHtml(cls);
  const duration = classDurationMinutes(cls);
  const instructor = staffName(cls);
  const metaParts = [instructor];
  if (duration != null) metaParts.push(`${duration} min`);

  return (
    <article className="my-class-card card">
      <button
        type="button"
        className="my-class-card__head"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="my-class-card__head-text">
          <h2>{classTitle(cls)}</h2>
          <p className="card__meta">{formatVisitWhen(visit)}</p>
        </div>
        <span className="my-class-card__chevron" aria-hidden="true">
          {expanded ? "▴" : "▾"}
        </span>
      </button>

      {expanded && (
        <div className="my-class-card__body">
          <span className="mb-schedule-slot__meta">{metaParts.join(" · ")}</span>
          {detailsHtml ? (
            <div
              className="mb-schedule-slot__details"
              dangerouslySetInnerHTML={{ __html: detailsHtml }}
            />
          ) : null}
        </div>
      )}

      <div className="my-class-card__actions">
        {showInviteGuest && onInviteGuest && (
          <button type="button" className="btn btn--cream my-class-card__invite" onClick={onInviteGuest}>
            Bring a friend
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost mb-schedule-slot__cancel"
          disabled={cancelBusy}
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        >
          {cancelBusy ? "Canceling…" : "Cancel booking"}
        </button>
        {detailsHtml && !expanded && (
          <button
            type="button"
            className="mb-schedule-slot__details-toggle"
            onClick={() => setExpanded(true)}
          >
            Show details
          </button>
        )}
        {detailsHtml && expanded && (
          <button
            type="button"
            className="mb-schedule-slot__details-toggle"
            onClick={() => setExpanded(false)}
          >
            Hide details
          </button>
        )}
      </div>
    </article>
  );
}
