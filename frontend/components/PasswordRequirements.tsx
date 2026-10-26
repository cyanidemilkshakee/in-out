"use client";

import { Check } from "lucide-react";
import { PASSWORD_REQUIREMENTS, passwordRequirementStatus } from "../../lib/passwordPolicy";
import styles from "./PasswordRequirements.module.css";

export function PasswordRequirements({ value }: { value: string }) {
  const status = passwordRequirementStatus(value);
  return <div className={styles.requirements}>
    <span className={styles.heading}>Password must have:</span>
    <ul aria-label="Password requirements">
      {PASSWORD_REQUIREMENTS.map(({ id, label }) => {
        const met = status[id];
        return <li key={id} data-met={met}>
          <span className={styles.indicator} aria-hidden="true">{met ? <Check size={12} strokeWidth={2.6} /> : null}</span>
          {label}
        </li>;
      })}
    </ul>
  </div>;
}
