import { useMemo } from "react";
import {
  completedVisitsFromSummary,
  formatVisitWhen,
  visitName,
  visitStatusLabel,
  type VisitRow,
} from "../../lib/visit-utils";
import { MemberDataTable } from "./MemberDataTable";

type Props = {
  summary: unknown;
};

export function VisitHistorySection({ summary }: Props) {
  const rows = useMemo(() => completedVisitsFromSummary(summary), [summary]);

  return (
    <section className="card profile-section">
      <h2>Class history</h2>
      <p className="profile-section__hint">Completed visits from the past two years.</p>
      <MemberDataTable<VisitRow>
        rows={rows}
        emptyMessage="No completed visits in this date range."
        getRowKey={(row, i) => `${visitName(row)}-${i}`}
        columns={[
          { key: "when", label: "When", render: (v) => formatVisitWhen(v) },
          { key: "class", label: "Class", render: visitName },
          { key: "status", label: "Status", render: visitStatusLabel },
        ]}
      />
    </section>
  );
}
