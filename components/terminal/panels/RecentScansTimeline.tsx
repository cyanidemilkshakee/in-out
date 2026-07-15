"use client";

import { ResultPill } from "../../StatusPill";
import type { MovementEvent } from "../../../lib/types";

export function RecentScansTimeline({ events }: { events: MovementEvent[] }) {
  return (
    <section className="timeline" aria-label="Recent scans timeline">
      <h3>Live Feed</h3>
      <div className="timelineList">
        {events.slice(0, 5).map((event) => (
          <div key={event.id} className="timelineItem">
            <span className="timelineTime">{event.time}</span>
            <span className="timelineName">{event.subjectName}</span>
            <ResultPill value={event.result} />
          </div>
        ))}
      </div>
    </section>
  );
}
