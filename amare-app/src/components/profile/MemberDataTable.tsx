type Column<T> = {
  key: string;
  label: string;
  render: (row: T) => string;
  className?: string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  emptyMessage: string;
  getRowKey: (row: T, index: number) => string;
};

export function MemberDataTable<T>({ columns, rows, emptyMessage, getRowKey }: Props<T>) {
  if (!rows.length) {
    return <p className="member-table__empty">{emptyMessage}</p>;
  }

  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={getRowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
