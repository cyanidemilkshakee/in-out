"use client";

import { useEffect, useState } from "react";
import { listZones } from "../../services/zoneService";
import type { OrganizationZone } from "../../lib/types";

// Share simultaneous metadata reads without retaining an authorization-scoped
// catalog after the request finishes. Later mounts still fetch current zones.
let pendingZones: Promise<OrganizationZone[]> | undefined;

function readZones() {
  if (!pendingZones) {
    pendingZones = listZones().finally(() => { pendingZones = undefined; });
  }
  return pendingZones;
}

export function useOrganizationZones() {
  const [zones, setZones] = useState<OrganizationZone[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void readZones().then((items) => {
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
