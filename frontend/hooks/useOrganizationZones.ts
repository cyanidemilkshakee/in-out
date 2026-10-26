"use client";

import { useEffect, useState } from "react";
import { listZones } from "../../services/zoneService";
import type { OrganizationZone } from "../../lib/types";

export function useOrganizationZones() {
  const [zones, setZones] = useState<OrganizationZone[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void listZones().then((items) => {
      if (active) setZones(items.filter((zone) => zone.active));
    }).catch(() => {
      if (active) setZones([]);
    }).finally(() => {
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, []);
  return { zones, loaded };
}
