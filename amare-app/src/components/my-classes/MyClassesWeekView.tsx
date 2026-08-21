import {
  addDaysToYmdEt,
  dateKeyEt,
  formatPillDate,
  formatPillWeekday,
  formatSlotTime,
  formatWeekRange,
  weekKeysEt,
} from "../../lib/schedule-utils";

export type WeekClassItem = {
  id: string;
  dayKey: string;
  isoMs: number;
  name: string;
  kind: "booked" | "waitlist";
  classId?: number | null;
};

type Props = {
  weekStart: string;
  items: WeekClassItem[];
  focusClassId?: number | null;
  onWeekStartChange: (dk: string) => void;
  onSelect?: (item: WeekClassItem) => void;
};

export function MyClassesWeekView({
  weekStart,
  items,
  focusClassId,
  onWeekStartChange,
  onSelect,
}: Props) {
  const todayKey = dateKeyEt(Date.now());
  const days = weekKeysEt(weekStart);
  const byDay = new Map<string, WeekClassItem[]>();
  for (const dk of days) byDay.set(dk, []);
  for (const item of items) {
    const bucket = byDay.get(item.dayKey);
    if (bucket) bucket.push(item);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.isoMs - b.isoMs);

  return (
    <div className="my-week">
      <div className="my-week__nav">
        <button
          type="button"
          className="my-week__nav-btn"
          aria-label="Previous week"
          onClick={() => onWeekStartChange(addDaysToYmdEt(weekStart, -7))}
        >
          ‹
        </button>
        <p className="my-week__range">{formatWeekRange(weekStart)}</p>
        <button
          type="button"
          className="my-week__nav-btn"
          aria-label="Next week"
          onClick={() => onWeekStartChange(addDaysToYmdEt(weekStart, 7))}
        >
          ›
        </button>
      </div>

      <ol className="my-week__days">
        {days.map((dk) => {
          const rows = byDay.get(dk) ?? [];
          return (
            <li key={dk} className={`my-week__day${dk === todayKey ? " is-today" : ""}`}>
              <div className="my-week__day-head">
                <span>{formatPillWeekday(dk, todayKey)}</span>
                <span>{formatPillDate(dk)}</span>
              </div>
              {rows.length === 0 ? (
                <p className="my-week__empty">No classes</p>
              ) : (
                <ul className="my-week__slots">
                  {rows.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`my-week__slot${item.kind === "waitlist" ? " is-waitlist" : ""}${
                          focusClassId != null && item.classId === focusClassId ? " is-focus" : ""
                        }`}
                        onClick={() => onSelect?.(item)}
                      >
                        <strong>{formatSlotTime(item.isoMs)}</strong>
                        <span>{item.name}</span>
                        {item.kind === "waitlist" ? <em>Waitlist</em> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
