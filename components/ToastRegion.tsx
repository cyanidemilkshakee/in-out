"use client";

export type ToastMessage = {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type ToastRegionProps = {
  toast: ToastMessage | null;
  onDismiss: () => void;
};

export function ToastRegion({ toast, onDismiss }: ToastRegionProps) {
  if (!toast) {
    return null;
  }

  return (
    <div className="toast-region" role="status" aria-live="polite">
      <div className="toast">
        <span>{toast.message}</span>
        {toast.actionLabel && toast.onAction ? (
          <button
            className="toast-action"
            type="button"
            onClick={() => {
              toast.onAction?.();
              onDismiss();
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
        <button className="toast-dismiss" type="button" onClick={onDismiss} aria-label="Dismiss notification">
          Close
        </button>
      </div>
    </div>
  );
}
