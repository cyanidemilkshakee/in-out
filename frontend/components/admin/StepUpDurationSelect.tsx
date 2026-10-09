"use client";

import { USER_MANAGEMENT_STEP_UP_DURATIONS, isStepUpDurationMinutes } from "../../../lib/userManagementStepUp";

type StepUpDurationMinutes = (typeof USER_MANAGEMENT_STEP_UP_DURATIONS)[number];

export function StepUpDurationSelect({ value, onChange, disabled = false, label = "Unlock duration" }: {
  value: StepUpDurationMinutes;
  onChange: (value: StepUpDurationMinutes) => void;
  disabled?: boolean;
  label?: string;
}) {
  return <label className="identity-duration-select">
    <span>{label}</span>
    <select value={value} disabled={disabled} onChange={(event) => {
      const durationMinutes = Number(event.target.value);
      if (isStepUpDurationMinutes(durationMinutes)) onChange(durationMinutes);
    }}>
      {USER_MANAGEMENT_STEP_UP_DURATIONS.map((durationMinutes) => <option key={durationMinutes} value={durationMinutes}>{durationMinutes === 60 ? "1 hour" : `${durationMinutes} minutes`}</option>)}
    </select>
  </label>;
}
