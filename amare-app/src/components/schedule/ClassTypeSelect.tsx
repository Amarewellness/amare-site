import type { ClassKindChip, FilterState } from "../../lib/schedule-utils";

type Props = {
  filters: FilterState;
  onChange: (next: FilterState) => void;
};

const KIND_CHIPS: { id: ClassKindChip; label: string }[] = [
  { id: "", label: "All" },
  { id: "reformer", label: "Reformer" },
  { id: "mat", label: "Mat" },
  { id: "heated", label: "Heated" },
  { id: "beginner", label: "Beginner" },
];

export function ClassTypeSelect({ filters, onChange }: Props) {
  return (
    <div className="mb-schedule-chips" role="group" aria-label="Class type">
      {KIND_CHIPS.map((chip) => {
        const active = filters.classKind === chip.id;
        return (
          <button
            key={chip.id || "all"}
            type="button"
            className={`mb-schedule-chip${active ? " is-active" : ""}`}
            aria-pressed={active}
            onClick={() => onChange({ ...filters, classKind: chip.id })}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
