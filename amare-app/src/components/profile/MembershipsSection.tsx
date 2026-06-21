import { useMemo } from "react";
import {
  findCommitmentForMembership,
  formatCommitmentCell,
  formatMemberDate,
  membershipsFromSummary,
  stripeCommitmentsFromSummary,
} from "../../lib/member-profile-utils";
import { MemberDataTable } from "./MemberDataTable";

type Props = {
  summary: unknown;
};

function membershipName(row: Record<string, unknown>): string {
  const n = row.MembershipName ?? row.Name ?? row.name ?? row.ProgramName ?? row.Description;
  return typeof n === "string" && n.trim() ? n.trim() : "—";
}

export function MembershipsSection({ summary }: Props) {
  const rows = useMemo(() => membershipsFromSummary(summary), [summary]);
  const commitments = useMemo(() => stripeCommitmentsFromSummary(summary), [summary]);
  const showCommitment = useMemo(
    () => rows.some((r) => findCommitmentForMembership(r, commitments) != null),
    [rows, commitments],
  );

  if (!rows.length && !commitments.length) return null;

  const columns = showCommitment
    ? [
        { key: "name", label: "Membership", render: membershipName },
        {
          key: "active",
          label: "Active",
          render: (row: Record<string, unknown>) => String(row.Active ?? row.active ?? "—"),
        },
        {
          key: "renews",
          label: "Renews on",
          render: (row: Record<string, unknown>) =>
            formatMemberDate(row.ExpirationDate ?? row.EndDate ?? row.end),
        },
        {
          key: "commitment",
          label: "Commitment until",
          render: (row: Record<string, unknown>) =>
            formatCommitmentCell(findCommitmentForMembership(row, commitments)),
        },
      ]
    : [
        { key: "name", label: "Membership", render: membershipName },
        {
          key: "active",
          label: "Active",
          render: (row: Record<string, unknown>) => String(row.Active ?? row.active ?? "—"),
        },
        {
          key: "end",
          label: "End",
          render: (row: Record<string, unknown>) =>
            formatMemberDate(row.ExpirationDate ?? row.EndDate ?? row.end),
        },
      ];

  return (
    <section className="card profile-section">
      <h2>Memberships</h2>
      {rows.length ? (
        <MemberDataTable
          rows={rows}
          emptyMessage="No memberships returned."
          getRowKey={(row, i) => `${String(row.Id ?? row.MembershipId ?? "m")}-${i}`}
          columns={columns}
        />
      ) : (
        commitments.map((c, i) => (
          <p key={i} className="card__meta">
            <strong>{c.displayName ?? "Membership"}</strong>
            {c.status ? ` — ${c.status}` : ""}
            {c.commitmentEndDate ? ` · Commitment until ${formatCommitmentCell(c)}` : ""}
          </p>
        ))
      )}
    </section>
  );
}
