import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { HardwareAsset } from '../../../lib/types';

export function HardwareTable({
  assets,
  onToggleInside
}: {
  assets: HardwareAsset[];
  onToggleInside: (assetId: string) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof HardwareAsset>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortedAssets = useMemo(() => {
    return [...assets].sort((a, b) => {
      const aValue = String(a[sortKey] ?? "");
      const bValue = String(b[sortKey] ?? "");
      return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    });
  }, [assets, sortDirection, sortKey]);

  function sortHeader(column: keyof HardwareAsset, label: string) {
    const active = sortKey === column;
    return (
      <th aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
        <button
          className="sort-button"
          type="button"
          onClick={() => {
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
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("barcode", "Barcode")}
              {sortHeader("owner", "Owner")}
              {sortHeader("category", "Category")}
              {sortHeader("status", "Status")}
              {sortHeader("inside", "Inside")}
            </tr>
          </thead>
          <tbody>
            {sortedAssets.map((asset) => (
              <tr key={asset.id}>
                <td>{asset.name}</td>
                <td>{asset.barcode}</td>
                <td>{asset.owner}</td>
                <td>{asset.category}</td>
                <td>{asset.status}</td>
                <td>{asset.inside ? "Inside" : "Outside"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}
