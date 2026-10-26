import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { HardwareAsset, RegistrySortKey, SortDirection } from '../../../../lib/types';
import Link from 'next/link';

export function HardwareTable({
  assets,
  sort,
}: {
  assets: HardwareAsset[];
  sort?: { key: RegistrySortKey; direction: SortDirection; onChange: (key: RegistrySortKey) => void };
}) {
  const [localSortKey, setSortKey] = useState<keyof HardwareAsset>("name");
  const [localSortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortKey = sort?.key ?? localSortKey;
  const sortDirection = sort?.direction ?? localSortDirection;
  const sortedAssets = useMemo(() => {
    return [...assets].sort((a, b) => {
      if (sort) return 0;
      const aValue = String(a[sortKey as keyof HardwareAsset] ?? "");
      const bValue = String(b[sortKey as keyof HardwareAsset] ?? "");
      return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    });
  }, [assets, sortDirection, sortKey, sort]);

  function sortHeader(column: keyof HardwareAsset, label: string) {
    const active = sortKey === column;
    return (
      <th
        className={`column-${String(column)}`}
        aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          className="sort-button"
          type="button"
          onClick={() => {
            if (sort) { sort.onChange(column as RegistrySortKey); return; }
            setSortDirection(active && sortDirection === "asc" ? "desc" : "asc");
            setSortKey(column);
          }}
        >
          <span>{label}</span>
          {active ? (sortDirection === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />) : <ArrowUpDown size={16} />}
        </button>
      </th>
    );
  }

  return (
      <div className="admin-table-wrap table-wrap scrollable-content">
        <table className="data-table hardware-table registry-table registry-table--hardware">
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("createdAt", "Created At")}
              {sortHeader("barcode", "Barcode")}
              {sortHeader("owner", "Owner")}
              {sortHeader("category", "Category")}
              {sortHeader("status", "Status")}
              {sortHeader("inside", "Inside")}
              <th scope="col">Requests</th>
            </tr>
          </thead>
          <tbody>
            {sortedAssets.map((asset) => (
              <tr key={asset.id}>
                <td className="column-name" data-label="Name">{asset.name}</td>
                <td className="column-createdAt" data-label="Created At">
                  {asset.createdAt
                    ? new Date(asset.createdAt).toLocaleString("en-IN")
                    : "Not recorded"}
                </td>
                <td className="column-barcode" data-label="Barcode">{asset.barcode}</td>
                <td className="column-owner" data-label="Owner">{asset.owner}</td>
                <td className="column-category" data-label="Category">{asset.category}</td>
                <td className="column-status" data-label="Status">{asset.status}</td>
                <td className="column-inside" data-label="Inside">
                  <span className={`registry-presence ${asset.inside ? "is-inside" : "is-outside"}`}>
                    {asset.inside ? "Inside" : "Outside"}
                  </span>
                </td>
                <td className="column-requests" data-label="Requests"><Link className="admin-button admin-button--secondary secondary-button compact-button" href={`/admin/permissions?subject=${encodeURIComponent(asset.id)}&requestType=hardware_custody`} aria-label={`Request custody of ${asset.name}`}>Request custody</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}
