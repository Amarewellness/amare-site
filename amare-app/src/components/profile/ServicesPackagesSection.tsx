import { useMemo, useState } from "react";
import {
  clientServicesFromSummary,
  formatMemberDate,
  formatPackVisitsRemainingReconciled,
  passesActiveServiceFilter,
} from "../../lib/member-profile-utils";
import { MemberDataTable } from "./MemberDataTable";

type Props = {
  summary: unknown;
};

function serviceName(row: Record<string, unknown>): string {
  const n = row.Name ?? row.ProgramName ?? row.serviceName;
  return typeof n === "string" && n.trim() ? n.trim() : "—";
}

export function ServicesPackagesSection({ summary }: Props) {
  const [showAll, setShowAll] = useState(false);
  const allRows = useMemo(() => clientServicesFromSummary(summary), [summary]);
  const filtered = useMemo(
    () => allRows.filter((row) => passesActiveServiceFilter(row, showAll)),
    [allRows, showAll],
  );

  const primaryId =
    filtered[0]?.Id ?? filtered[0]?.id ?? allRows[0]?.Id ?? allRows[0]?.id ?? null;

  return (
    <section className="card profile-section">
      <h2>Services &amp; packages</h2>
      <p className="profile-section__hint">
        Prepaid packs and class credits. Visits left update after you book — they appear here, not
        under Account balance.
      </p>
      <label className="profile-section__filter">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        <span>Show expired &amp; empty packs</span>
      </label>
      <MemberDataTable
        rows={filtered}
        emptyMessage={
          allRows.length && !showAll
            ? 'No active packages. Enable "Show expired & empty packs" to see all Mindbody rows.'
            : "No packages returned."
        }
        getRowKey={(row, i) => `${String(row.Id ?? row.id ?? "s")}-${i}`}
        columns={[
          { key: "name", label: "Service", render: serviceName },
          {
            key: "visits",
            label: "Visits left",
            render: (row) => {
              const id = row.Id ?? row.id;
              const isPrimary = primaryId != null && id === primaryId;
              return formatPackVisitsRemainingReconciled(row, summary, isPrimary);
            },
          },
          {
            key: "exp",
            label: "Expires",
            render: (row) =>
              formatMemberDate(row.ExpirationDate ?? row.expirationDate ?? row.End ?? row.endDate),
          },
        ]}
      />
    </section>
  );
}
