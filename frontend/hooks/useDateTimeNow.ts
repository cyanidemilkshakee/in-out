import { useEffect, useState } from "react";

/** Keep native calendar limits current while a dialog stays open. */
export function useDateTimeNow(active = true) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const update = () => {
      setNow(new Date());
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 60_000 - Date.now() % 60_000 + 10);
    };
    update();
    window.addEventListener("focus", update);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", update); };
  }, [active]);
  return now;
}
