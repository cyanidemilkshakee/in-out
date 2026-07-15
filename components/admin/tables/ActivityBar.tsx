export function ActivityBar({ seed }: { seed: string }) {
  const val = seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const layoutType = val % 4;
  
  let segments = [];
  if (layoutType === 0) {
    segments = [
      { type: "green", width: 45 },
      { type: "blue", width: 10 },
      { type: "green", width: 30 },
      { type: "red", width: 15 },
    ];
  } else if (layoutType === 1) {
    segments = [
      { type: "red", width: 20 },
      { type: "green", width: 55 },
      { type: "blue", width: 10 },
      { type: "green", width: 15 },
    ];
  } else if (layoutType === 2) {
    segments = [
      { type: "green", width: 85 },
      { type: "red", width: 15 },
    ];
  } else {
    segments = [
      { type: "red", width: 10 },
      { type: "green", width: 40 },
      { type: "blue", width: 15 },
      { type: "green", width: 25 },
      { type: "red", width: 10 },
    ];
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "320px" }}>
      <div
        style={{
          display: "flex",
          height: "6px",
          width: "100%",
          borderRadius: "6px",
          overflow: "hidden",
          gap: "2px",
          background: "rgba(0,0,0,0.05)",
        }}
      >
        {segments.map((seg, i) => {
          let bg = "var(--green)";
          if (seg.type === "blue") bg = "var(--blue)";
          if (seg.type === "red") bg = "rgba(0,0,0,0.15)";
          return (
            <div
              key={i}
              style={{ width: `${seg.width}%`, background: bg }}
              title={`${seg.width}% ${seg.type}`}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--admin-subtext)", fontWeight: 500 }}>
        <span>9am</span>
        <span>12pm</span>
        <span>3pm</span>
        <span>6pm</span>
        <span>9pm</span>
      </div>
    </div>
  );
}
