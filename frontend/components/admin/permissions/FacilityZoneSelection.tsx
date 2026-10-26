import { normalizeFacilityZones } from "../../../../lib/facilityZones";
import type { OrganizationZone } from "../../../../lib/types";
import styles from "./FacilityZoneSelection.module.css";

export function FacilityZoneSelection({ label, value, onChange, disabled = false, invalid = false, zones = [] }: {
  label: string;
  value: readonly string[];
  onChange: (zones: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  zones?: OrganizationZone[];
}) {
  return (
    <fieldset className={`${styles.selection} admin-surface`} disabled={disabled} aria-invalid={invalid || undefined}>
      <legend>{label}</legend>
      <div className={styles.choices}>
        {zones.map((zone) => (
          <label key={zone.id} className={styles.choice}>
            <input type="checkbox" value={zone.id} checked={value.includes(zone.id)} onChange={(event) => onChange(normalizeFacilityZones(event.target.checked ? [...value, zone.id] : value.filter((item) => item !== zone.id)))} />
            <span>{zone.name}</span>
          </label>
        ))}
        {!zones.length && <p role="status">No active zones are available.</p>}
      </div>
    </fieldset>
  );
}
