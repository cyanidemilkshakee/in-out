import { FACILITY_ZONES, normalizeFacilityZones } from "../../../../lib/facilityZones";
import styles from "./FacilityZoneSelection.module.css";

export function FacilityZoneSelection({ label, value, onChange, disabled = false, invalid = false }: {
  label: string;
  value: readonly string[];
  onChange: (zones: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <fieldset className={`${styles.selection} admin-surface`} disabled={disabled} aria-invalid={invalid || undefined}>
      <legend>{label}</legend>
      <div className={styles.choices}>
        {FACILITY_ZONES.map((zone) => (
          <label key={zone.id} className={styles.choice}>
            <input type="checkbox" value={zone.id} checked={value.includes(zone.id)} onChange={(event) => onChange(normalizeFacilityZones(event.target.checked ? [...value, zone.id] : value.filter((item) => item !== zone.id)))} />
            <span>{zone.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
