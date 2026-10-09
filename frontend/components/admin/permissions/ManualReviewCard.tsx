"use client";

import { Check, Clock3, MapPin, X } from "lucide-react";
import type { PermissionRequest } from "../../../../lib/types";
import { MANUAL_REVIEW_DURATIONS } from "../../../../lib/manualReviewDuration";
import { ManualReviewCountdown } from "../../ManualReviewCountdown";
import { formatRequestDate } from "./requestPresentation";
import styles from "./ManualReviewCard.module.css";

export type ManualReviewCardProps = {
  request: PermissionRequest;
  checkpointName?: string;
  decisionNote: string;
  noteInvalid: boolean;
  noteInputRef: (element: HTMLInputElement | null) => void;
  onNoteChange: (value: string) => void;
  validForMinutes: number;
  onDurationChange: (minutes: number) => void;
  disabled: boolean;
  onDecision: (decision: "approved" | "denied") => void;
  id?: string;
  className?: string;
  tabIndex?: number;
};

export function ManualReviewCard({
  request,
  checkpointName,
  decisionNote,
  noteInvalid,
  noteInputRef,
  onNoteChange,
  validForMinutes,
  onDurationChange,
  disabled,
  onDecision,
  id,
  className,
  tabIndex,
}: ManualReviewCardProps) {
  const subjectName = request.subjectName.trim() || "Unregistered barcode";
  const operatorNote = request.operatorNote?.trim();
  const pending = request.status === "pending";

  return (
    <article
      id={id}
      className={`${styles.card}${className ? ` ${className}` : ""}`}
      tabIndex={tabIndex}
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Clock3 size={19} strokeWidth={1.8} />
        </span>
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <strong className={styles.title}>
              {subjectName}{request.barcode ? ` · ${request.barcode}` : ""}
            </strong>
            {checkpointName ? (
              <span className={styles.checkpoint}>
                <MapPin size={13} strokeWidth={1.8} aria-hidden="true" />
                {checkpointName}
              </span>
            ) : null}
          </div>
          <time className={styles.date} dateTime={request.createdAt}>
            {formatRequestDate(request.createdAt)}
          </time>
          {pending ? <ManualReviewCountdown createdAt={request.createdAt} /> : null}
        </div>
      </header>
      {operatorNote ? (
        <div className={styles.context}>
          <span className={styles.operatorNote}>
            <strong>Operator note</strong>
            <span>{operatorNote}</span>
          </span>
        </div>
      ) : null}
      {pending ? (
        <>
          <label className={styles.note}>
            <input
              ref={noteInputRef}
              type="text"
              aria-label="Decision note"
              value={decisionNote}
              disabled={disabled}
              aria-invalid={noteInvalid}
              placeholder="Add a note if you deny this permission."
              maxLength={1000}
              onChange={(event) => onNoteChange(event.target.value)}
            />
          </label>
          <div className={styles.controls}>
            <label className={styles.duration}>
              <span>Valid for</span>
              <select
                aria-label={`Valid for manual request ${request.id} for ${subjectName}`}
                value={validForMinutes}
                disabled={disabled}
                onChange={(event) => onDurationChange(Number(event.target.value))}
              >
                {MANUAL_REVIEW_DURATIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
              </select>
            </label>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.approve}
                aria-label={`Approve for ${subjectName}`}
                title="Approve"
                disabled={disabled}
                onClick={() => onDecision("approved")}
              >
                <Check size={16} strokeWidth={2.2} />
                <span>Approve</span>
              </button>
              <button
                type="button"
                className={styles.deny}
                aria-label={`Deny ${subjectName}`}
                title="Deny"
                disabled={disabled}
                onClick={() => onDecision("denied")}
              >
                <X size={16} strokeWidth={2.2} />
                <span>Deny</span>
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <strong className={styles.status} data-status={request.status}>{request.status === "approved" ? "Approved" : "Denied"}</strong>
          {request.decisionReason ? <span className={styles.decisionReason}>{request.decisionReason}</span> : null}
        </>
      )}
    </article>
  );
}
