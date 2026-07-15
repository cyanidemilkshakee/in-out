"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { PeopleTable } from "../../../components/admin/tables/PeopleTable";
import { TemporaryVisitorCreator } from "../../../components/admin/tables/TemporaryVisitorCreator";
import { MetricTrendChart } from "../../../components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../components/analytics/TrendChart";
import { Download } from "lucide-react";
import { useDataActions, useDataState } from "../../../context/DataContext";

export default function VisitorsPage() {
  const { people: staff } = useDataState();
  const { createTemporaryVisitor, updatePerson } = useDataActions();
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  function handleToggleInside(personId: string) {
    const person = staff.find((item) => item.id === personId);
    if (person) void updatePerson(personId, { inside: !person.inside });
  }

  // Filter only visitors, and apply search
  const visitors = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return staff.filter(
      (person) =>
        person.type === "visitor" &&
        (!needle ||
          person.name.toLowerCase().includes(needle) ||
          person.barcode.toLowerCase().includes(needle))
    );
  }, [deferredSearch, staff]);
  const preApprovedCount = useMemo(
    () => visitors.reduce((count, person) => count + (person.status === "pre_approved" ? 1 : 0), 0),
    [visitors]
  );

  return (
    <AdminPageFrame
      title="Visitor Access"
      description="Issue temporary passes, inspect host approvals, and keep visitor identities aligned with the movement ledger."
      metric={`${preApprovedCount} pre-approved`}
      headerRight={
        <MetricTrendChart
          title="Visitors"
          valueLabel="AVG VISITORS"
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          color="#db2777"
          seed={24}
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
            <TemporaryVisitorCreator onCreate={createTemporaryVisitor} />
            <button className="ghost-button" type="button">
              <Download />
              Export
            </button>
            <label className="search-control" style={{ marginLeft: "auto" }}>
              <span className="sr-only">Search visitors</span>
              <input
                type="search"
                placeholder="Search name or barcode..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <PeopleTable
            title="Visitors"
            people={visitors}
            onToggleInside={handleToggleInside}
          />
        </div>
      </section>
    </AdminPageFrame>
  );
}
