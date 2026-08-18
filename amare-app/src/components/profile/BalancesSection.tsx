import { useMemo } from "react";
import {
  balanceAmount,
  balanceLabel,
  flattenBalanceRows,
  hasDisplayableAccountCredit,
} from "../../lib/member-profile-utils";
import { MemberDataTable } from "./MemberDataTable";

type Props = {
  summary: unknown;
};

export function BalancesSection({ summary }: Props) {
  const rows = useMemo(() => {
    if (!summary || typeof summary !== "object") return [];
    return flattenBalanceRows((summary as Record<string, unknown>).balances);
  }, [summary]);

  if (!hasDisplayableAccountCredit(rows)) return null;

  return (
    <section className="card profile-section">
      <h2>Account credit</h2>
      <MemberDataTable
        rows={rows.filter((row) => {
          const raw = balanceAmount(row);
          return raw !== "—" && raw !== "$0.00";
        })}
        emptyMessage="No account credit."
        getRowKey={(row, i) => `${balanceLabel(row)}-${i}`}
        columns={[
          { key: "desc", label: "Description", render: balanceLabel },
          { key: "amt", label: "Amount", render: balanceAmount, className: "member-table__num" },
        ]}
      />
    </section>
  );
}
