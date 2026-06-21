import { useRef } from "react";
import {
  dateKeyEt,
  formatPillDate,
  formatPillWeekday,
  type ScheduleRow,
} from "../../lib/schedule-utils";

type Props = {
  stripKeys: string[];
  selectedDayKey: string;
  counts: Record<string, number>;
  enrollmentByDay: Set<string>;
  onSelect: (dk: string) => void;
};

export function DayStrip({ stripKeys, selectedDayKey, counts, enrollmentByDay, onSelect }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const todayKey = dateKeyEt(Date.now());

  function scrollBy(delta: number) {
    const el = stripRef.current;
    if (!el) return;
    const step = Math.max(220, Math.round(el.clientWidth * 0.68));
    el.scrollBy({ left: delta * step, behavior: "smooth" });
  }

  return (
    <div className="mb-schedule-calendar">
      <p className="mb-schedule-daystrip__hint" lang="en">
        Choose the day
      </p>
      <div className="mb-schedule-daystrip-shell">
        <button
          type="button"
          className="mb-schedule-daystrip__nav-btn mb-schedule-daystrip__nav-btn--prev"
          aria-label="Scroll to earlier days"
          onClick={() => scrollBy(-1)}
        >
          ‹
        </button>
        <div
          ref={stripRef}
          className="mb-schedule-daystrip"
          role="tablist"
          aria-label="Schedule days"
        >
          {stripKeys.map((dk) => {
            const n = counts[dk] ?? 0;
            const hasBooking = enrollmentByDay.has(dk);
            const w = formatPillWeekday(dk, todayKey);
            const classes = [
              "mb-schedule-daypill",
              dk === selectedDayKey && "is-selected",
              dk === todayKey && "is-today",
              n === 0 && "mb-schedule-daypill--quiet",
              hasBooking && "mb-schedule-daypill--has-booking",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={dk}
                type="button"
                role="tab"
                className={classes}
                aria-selected={dk === selectedDayKey}
                aria-label={hasBooking ? `${w}, ${formatPillDate(dk)}. You have a booking this day` : undefined}
                onClick={() => onSelect(dk)}
              >
                <span
                  className={`mb-schedule-daypill__abbr${dk === todayKey ? " mb-schedule-daypill__abbr--today" : ""}`}
                >
                  {w}
                </span>
                <span className="mb-schedule-daypill__md">{formatPillDate(dk)}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="mb-schedule-daystrip__nav-btn mb-schedule-daystrip__nav-btn--next"
          aria-label="Scroll to later days"
          onClick={() => scrollBy(1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}

export function enrollmentDaysFromRows(
  rows: ScheduleRow[],
  enrollVisitByClassId: Map<number, number>,
): Set<string> {
  const days = new Set<string>();
  if (enrollVisitByClassId.size === 0) return days;
  for (const row of rows) {
    const cid = row.cls.Id ?? row.cls.id;
    const id = typeof cid === "number" ? cid : parseInt(String(cid), 10);
    if (Number.isFinite(id) && enrollVisitByClassId.has(id)) days.add(row.dk);
  }
  return days;
}
