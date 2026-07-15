"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { HardwareTable } from "../../../components/admin/tables/HardwareTable";
import { MetricTrendChart } from "../../../components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../components/analytics/TrendChart";
import { Download } from "lucide-react";
import { useDataActions, useDataState } from "../../../context/DataContext";

export default function HardwarePage() {
  const { hardwareAssets: assets } = useDataState();
  const { updateHardwareAsset } = useDataActions();
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  function handleToggleInside(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    if (asset) void updateHardwareAsset(assetId, { inside: !asset.inside });
  }

  const filteredAssets = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    if (!needle) return assets;
    return assets.filter(
      (asset) =>
        asset.name.toLowerCase().includes(needle) ||
        asset.barcode.toLowerCase().includes(needle) ||
        asset.owner.toLowerCase().includes(needle)
    );
  }, [assets, deferredSearch]);
  const restrictedCount = useMemo(() => assets.reduce((count, asset) => count + (asset.status === "restricted" ? 1 : 0), 0), [assets]);

  return (
    <AdminPageFrame
      title="Hardware Custody"
      description="Track restricted exits, owner departments, and physical assets moving through monitored checkpoints."
      metric={`${restrictedCount} restricted`}
      headerRight={
        <MetricTrendChart
          title="Hardware scans"
          valueLabel="AVG HARDWARE ACTIVITY"
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          color="#8b5cf6"
          seed={42}
        />
      }
    >
      <section className="split-workspace log-workspace">
        <div className="workspace-main">
          <div className="filter-bar">
            <label className="select-control">
              <span className="sr-only">Filter by time</span>
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as TimeRange)}
              >
                <option value="1Y">Last 1 Year</option>
                <option value="1M">Last 1 Month</option>
                <option value="1W">Last 1 Week</option>
                <option value="1D">Last 24 Hours</option>
              </select>
            </label>
            <button className="ghost-button" type="button">
              <Download />
              Export
            </button>
            <label className="search-control" style={{ marginLeft: "auto" }}>
              <span className="sr-only">Search hardware</span>
              <input
                type="search"
                placeholder="Search name, barcode, owner..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <HardwareTable
            assets={filteredAssets}
            onToggleInside={handleToggleInside}
          />
        </div>
      </section>
    </AdminPageFrame>
  );
}
