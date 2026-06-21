import type { FilterState } from "../../lib/schedule-utils";

type Props = {
  filters: FilterState;
  classTitles: string[];
  onChange: (next: FilterState) => void;
};

export function ClassTypeSelect({ filters, classTitles, onChange }: Props) {
  return (
    <div className="mb-schedule-classselect-field">
      <label className="mb-schedule-classselect__label" htmlFor="schedule-class-type">
        Class type · this day
      </label>
      <select
        id="schedule-class-type"
        className="mb-schedule-filter__select"
        value={filters.classTitle}
        onChange={(e) => onChange({ ...filters, classTitle: e.target.value })}
      >
        <option value="">All classes</option>
        {classTitles.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}
