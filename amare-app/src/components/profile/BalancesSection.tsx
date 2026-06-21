import { useMemo } from "react";
import { balanceAmount, balanceLabel, flattenBalanceRows } from "../../lib/member-profile-utils";
import { MemberDataTable } from "./MemberDataTable";

type Props = {
  summary: unknown;
};

export function BalancesSection({ summary }: Props) {
  const rows = useMemo(() => {
    if (!summary || typeof summary !== "object") return [];
    return flattenBalanceRows((summary as Record<string, unknown>).balances);
  }, [summary]);

  return (
    <section className="card profile-section">
      <h2>Account balance</h2>
      <p className="profile-section__hint">
        Studio account credit from Mindbody — often $0 if you paid by card for a pack. Class visits
        appear under Services &amp; packages.
      </p>
      <MemberDataTable
        rows={rows}
        emptyMessage="No balance rows returned."
        getRowKey={(row, i) => `${balanceLabel(row)}-${i}`}
        columns={[
          { key: "desc", label: "Description", render: balanceLabel },
          { key: "amt", label: "Amount", render: balanceAmount, className: "member-table__num" },
        ]}
      />
    </section>
  );
}
