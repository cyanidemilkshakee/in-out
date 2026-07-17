"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { Doughnut } from "react-chartjs-2";
import {
  ArcElement,
  Chart as ChartJS,
  Tooltip,
} from "chart.js";
import type { ChartEvent, ActiveElement } from "chart.js";

ChartJS.register(ArcElement, Tooltip);

export interface AnalyticsNode {
  id: string;
  label: string;
  value: number;
  children?: AnalyticsNode[];
  color?: string;
}

export interface ScanAnalytics {
  totalScans: number;
  sections: AnalyticsNode[];
}

interface DrillDownDoughnutProps {
  data: ScanAnalytics;
}

const rootColorPalette = ["#12b76a", "#f04438", "#f79009", "#0b63e5", "#8a3ffc"];

export function DrillDownDoughnut({ data }: DrillDownDoughnutProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [lockedId, setLockedId] = useState<string | null>(null);
  const [themeColors, setThemeColors] = useState({
    border: "#18201f"
  });
  const chartRef = useRef<any>(null);

  const displayId = lockedId || hoveredId;

  useEffect(() => {
    const readThemeColors = () => {
      const shell = document.querySelector<HTMLElement>(".role-admin");
      const styles = shell ? getComputedStyle(shell) : getComputedStyle(document.documentElement);
      setThemeColors({
        border: styles.getPropertyValue("--admin-bg").trim() || "#18201f"
      });
    };

    readThemeColors();
    const observer = new MutationObserver(readThemeColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-admin-theme"] });
    return () => observer.disconnect();
  }, []);

  const chartData = useMemo(() => {
    const rootData: number[] = [];
    const rootColors: string[] = [];
    const rootLabels: string[] = [];
    const rootIds: string[] = [];

    data.sections.forEach((sec, i) => {
      rootData.push(sec.value);
      rootColors.push(sec.color || rootColorPalette[i % rootColorPalette.length]);
      rootLabels.push(sec.label);
      rootIds.push(sec.id);
    });

    const datasets: any[] = [
      {
        data: rootData,
        backgroundColor: rootColors,
        borderColor: themeColors.border,
        borderWidth: 2,
        labels: rootLabels,
        ids: rootIds,
        level: 0,
      },
    ];

    if (!displayId) {
      return { labels: rootLabels, datasets };
    }

    const activeIndex = data.sections.findIndex((s) => s.id === displayId);
    if (activeIndex === -1) {
      return { labels: rootLabels, datasets };
    }

    const activeSection = data.sections[activeIndex];
    if (!activeSection.children?.length) {
      return { labels: rootLabels, datasets };
    }

    const l1Data: number[] = [];
    const l1Colors: string[] = [];
    const l1Labels: string[] = [];
    const l1Ids: string[] = [];

    const l2Data: number[] = [];
    const l2Colors: string[] = [];
    const l2Labels: string[] = [];
    const l2Ids: string[] = [];

    const isApproved = activeSection.id === "approved";
    // We can use a palette array based on the active section
    const palette = isApproved
      ? ["#32d583", "#6ce9a6", "#a6f4c5", "#027a48"]
      : ["#f97066", "#fda29b", "#fecdca", "#b42318"];

    let colorIndex1 = 0;
    let colorIndex2 = 0;

    data.sections.forEach((sec, i) => {
      if (i === activeIndex && sec.children) {
        sec.children.forEach((child) => {
          l1Data.push(child.value);
          l1Labels.push(child.label);
          l1Ids.push(child.id);
          l1Colors.push(palette[colorIndex1 % palette.length]);
          colorIndex1++;

          if (child.children?.length) {
            child.children.forEach((grandchild) => {
              l2Data.push(grandchild.value);
              l2Labels.push(grandchild.label);
              l2Ids.push(grandchild.id);
              l2Colors.push(palette[colorIndex2 % palette.length]);
              colorIndex2++;
            });
          } else {
            // Spacer for child
            l2Data.push(child.value);
            l2Labels.push("");
            l2Ids.push("");
            l2Colors.push("transparent");
          }
        });
      } else {
        // Spacer for Level 1
        l1Data.push(sec.value);
        l1Labels.push("");
        l1Ids.push("");
        l1Colors.push("transparent");

        // Spacer for Level 2
        l2Data.push(sec.value);
        l2Labels.push("");
        l2Ids.push("");
        l2Colors.push("transparent");
      }
    });

    const getBorders = (colors: string[]) => colors.map((c) => (c === "transparent" ? "transparent" : themeColors.border));
    const getWidths = (colors: string[]) => colors.map((c) => (c === "transparent" ? 0 : 2));

    datasets.push({
      data: l1Data,
      backgroundColor: l1Colors,
      borderColor: getBorders(l1Colors),
      borderWidth: getWidths(l1Colors),
      labels: l1Labels,
      ids: l1Ids,
      level: 1,
    });

    if (l2Data.some((_, i) => l2Colors[i] !== "transparent")) {
      datasets.push({
        data: l2Data,
        backgroundColor: l2Colors,
        borderColor: getBorders(l2Colors),
        borderWidth: getWidths(l2Colors),
        labels: l2Labels,
        ids: l2Ids,
        level: 2,
      });
    }

    return {
      labels: rootLabels,
      datasets,
    };
  }, [data, displayId, themeColors.border]);

  const onHover = (event: ChartEvent, elements: ActiveElement[]) => {
    if (lockedId) return; // If locked, hover doesn't change anything

    if (elements.length > 0) {
      // Find if we are hovering on a Level 0 dataset
      const element = elements[0];
      const dataset = chartData.datasets[element.datasetIndex];
      
      // We only allow expanding top-level nodes for this drill down
      if (dataset.level === 0) {
        const id = dataset.ids[element.index];
        setHoveredId(id);
        return;
      }
    }
    
    // If not hovering over a valid root element, we can clear the hover
    // Wait, if they hover over child elements, we don't want to collapse it!
    // If they hover over level 1 or level 2, the displayId shouldn't change.
    if (elements.length === 0) {
      setHoveredId(null);
    }
  };

  const onClick = (event: ChartEvent, elements: ActiveElement[]) => {
    if (elements.length > 0) {
      const element = elements[0];
      const dataset = chartData.datasets[element.datasetIndex];
      
      if (dataset.level === 0) {
        const id = dataset.ids[element.index];
        if (lockedId === id) {
          // Toggle off
          setLockedId(null);
        } else {
          // Lock to this one
          setLockedId(id);
        }
        return;
      }
    } else {
      // Clicked outside, unlock
      setLockedId(null);
    }
  };

  return (
    <div 
      style={{ position: "relative", width: "100%", height: "100%" }}
      onMouseLeave={() => { if (!lockedId) setHoveredId(null); }}
    >
      <Doughnut
        ref={chartRef}
        data={chartData}
        options={{
          maintainAspectRatio: false,
          cutout: "50%", // Smaller cutout to leave room for rings
          layout: {
            padding: 10
          },
          onHover,
          onClick,
          plugins: {
            legend: {
              display: false,
            },
            tooltip: {
              backgroundColor: "#000000",
              bodyFont: { size: 13, family: "Urbanist, Arial, sans-serif" },
              cornerRadius: 8,
              displayColors: false,
              titleFont: { size: 13, weight: 800, family: "Urbanist, Arial, sans-serif" },
              padding: 8,
              callbacks: {
                title: () => "",
                label: function (context) {
                  const dataset = context.dataset as any;
                  const value = context.raw as number;
                  const label = dataset.labels[context.dataIndex];
                  if (!label) return ""; // Spacer slice
                  return `${label}: ${value}`;
                },
              },
              filter: function (tooltipItem) {
                // Don't show tooltip for transparent spacer slices
                const dataset = tooltipItem.dataset as any;
                const label = dataset.labels[tooltipItem.dataIndex];
                return !!label;
              }
            },
          },
        }}
      />
    </div>
  );
}

export const mockData: ScanAnalytics = {
  totalScans: 700,
  sections: [
    {
      id: "approved",
      label: "Approved",
      value: 450,
      children: [
        {
          id: "automaticApproved",
          label: "Automatic",
          value: 350,
          children: [
            { id: "autoEntry", label: "Entries", value: 200 },
            { id: "autoExit", label: "Exits", value: 150 }
          ]
        },
        {
          id: "manualApproved",
          label: "Manual",
          value: 100,
          children: [
            { id: "manualEntry", label: "Entries", value: 50 },
            { id: "manualExit", label: "Exits", value: 50 }
          ]
        }
      ]
    },
    {
      id: "denied",
      label: "Denied",
      value: 250,
      children: [
        {
          id: "automaticDenied",
          label: "Automatic",
          value: 200,
          children: [
            { id: "restrictedAuto", label: "Restricted", value: 150 },
            { id: "expiredAuto", label: "Expired", value: 50 }
          ]
        },
        {
          id: "manualDenied",
          label: "Manual",
          value: 50,
          children: [
            { id: "restrictedManual", label: "Restricted", value: 30 },
            { id: "expiredManual", label: "Expired", value: 20 }
          ]
        }
      ]
    }
  ]
};
