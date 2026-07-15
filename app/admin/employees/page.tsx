"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { EmployeeTable } from "../../../components/admin/tables/EmployeeTable";
import { MetricTrendChart } from "../../../components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../components/analytics/TrendChart";
import { Download } from "lucide-react";
import { useDataState } from "../../../context/DataContext";

export default function EmployeesPage() {
  const { people: staff } = useDataState();
  const [search, setSearch] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("1M");
  const deferredSearch = useDeferredValue(search);

  // Filter only employees, and apply search
  const employees = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return staff.filter(
      (person) =>
        person.type === "employee" &&
        (!needle ||
          person.name.toLowerCase().includes(needle) ||
          person.barcode.toLowerCase().includes(needle))
    );
  }, [deferredSearch, staff]);
  const insideEmployees = useMemo(() => employees.reduce((count, person) => count + (person.inside ? 1 : 0), 0), [employees]);

  return (
    <AdminPageFrame
      title="Employee Directory"
      description="Manage employee presence, role-linked access, and checkpoint identity records from the operations data model."
      metric={`${insideEmployees}/${employees.length} on-site`}
      headerRight={
        <MetricTrendChart
          title="Working hours"
          valueLabel="AVG WORKING HOURS"
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          color="#ea580c"
          seed={18}
          unit="h"
        />
      }
    >
      <section className="log-workspace" style={{ padding: "0 18px" }}>
        <div className="workspace-main">
          <div className="filter-bar">
            <button className="ghost-button" type="button">
              <Download />
              Export
            </button>
            <label className="search-control" style={{ marginLeft: "auto" }}>
              <span className="sr-only">Search employees</span>
              <input
                type="search"
                placeholder="Search name or barcode..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <EmployeeTable people={employees} />
        </div>
      </section>
    </AdminPageFrame>
  );
}
