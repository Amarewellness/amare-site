import type { FilterState } from "../../lib/schedule-utils";

type Props = {
  filters: FilterState;
  instructors: string[];
  classTitles: string[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (next: FilterState) => void;
  onClear: () => void;
};

export function ScheduleFilters({
  filters,
  instructors,
  classTitles,
  expanded,
  onToggleExpanded,
  onChange,
  onClear,
}: Props) {
  function patch(partial: Partial<FilterState>) {
    onChange({ ...filters, ...partial });
  }

  const advancedOn = Boolean(filters.timeBucket || filters.instructor || filters.classTitle || filters.q);

  return (
    <section className="mb-schedule-filters" aria-label="Filters">
      <button
        type="button"
        className={`mb-schedule-filters__toggle${advancedOn ? " is-active" : ""}`}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        Filters{advancedOn ? " on" : ""}
      </button>

      {expanded && (
        <div className="mb-schedule-filters__extra">
          <div className="mb-schedule-filters__head">
            <h2 className="mb-schedule-filters__title">More filters</h2>
            <button type="button" className="mb-schedule-filters__clear" onClick={onClear}>
              Clear
            </button>
          </div>
          <div className="mb-schedule-filters__grid">
            <div className="mb-schedule-filter">
              <label htmlFor="schedule-class-type">Class name</label>
              <select
                id="schedule-class-type"
                className="mb-schedule-filter__select"
                value={filters.classTitle}
                onChange={(e) => patch({ classTitle: e.target.value })}
              >
                <option value="">All classes</option>
                {classTitles.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-schedule-filter">
              <label htmlFor="schedule-flt-time">Time of day (ET)</label>
              <select
                id="schedule-flt-time"
                className="mb-schedule-filter__select"
                value={filters.timeBucket}
                onChange={(e) => patch({ timeBucket: e.target.value })}
              >
                <option value="">Any time</option>
                <option value="morning">Morning (before noon)</option>
                <option value="afternoon">Afternoon (12:00 PM – 4:59 PM)</option>
                <option value="evening">Evening (5:00 PM – 8:59 PM)</option>
                <option value="late">Late evening (after 9:00 PM)</option>
                <option value="earlybird">Early (before 7:00 AM)</option>
              </select>
            </div>
            <div className="mb-schedule-filter">
              <label htmlFor="schedule-flt-instructor">Instructor</label>
              <select
                id="schedule-flt-instructor"
                className="mb-schedule-filter__select"
                value={filters.instructor}
                onChange={(e) => patch({ instructor: e.target.value })}
              >
                <option value="">All instructors</option>
                {instructors.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-schedule-filter mb-schedule-filter--span">
              <label htmlFor="schedule-flt-q">Search</label>
              <input
                id="schedule-flt-q"
                type="search"
                className="mb-schedule-filter__input"
                placeholder="Class or instructor"
                value={filters.q}
                onChange={(e) => patch({ q: e.target.value })}
                autoComplete="off"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export const emptyFilters = (): FilterState => ({
  timeBucket: "",
  instructor: "",
  classTitle: "",
  classKind: "",
  q: "",
});
