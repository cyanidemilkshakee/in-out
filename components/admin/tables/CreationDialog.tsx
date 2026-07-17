import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BadgePlus, X } from "lucide-react";

export function CreationDialog({
  triggerLabel,
  title,
  description,
  submitLabel,
  cardClassName = "",
  error,
  onOpen,
  onSubmit,
  children,
}: {
  triggerLabel: string;
  title: string;
  description: string;
  submitLabel: string;
  cardClassName?: string;
  error?: string;
  onOpen?: () => void;
  onSubmit: () => Promise<boolean | void> | boolean | void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  async function submit() {
    setSubmitting(true);
    try {
      const shouldClose = await onSubmit();
      if (shouldClose !== false) setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="temporary-id-popover">
      <button
        className="ghost-button temporary-create-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        <BadgePlus aria-hidden="true" />
        {triggerLabel}
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="temporary-id-overlay role-admin"
              role="presentation"
              onMouseDown={() => setOpen(false)}
            >
              <form
                className={`temporary-id-form temporary-id-card creation-dialog-card ${cardClassName}`.trim()}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onMouseDown={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <div className="temporary-id-card-header creation-dialog-header">
                  <div className="creation-dialog-heading">
                    <strong>{title}</strong>
                    <span>{description}</span>
                  </div>
                  <button
                    className="icon-button compact-button"
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label={`Close ${title.toLowerCase()}`}
                  >
                    <X size={17} />
                  </button>
                </div>

                {children}

                {error ? <p className="temporary-id-form-error" role="alert">{error}</p> : null}
                <button className="primary-button creation-dialog-submit" type="submit" disabled={submitting}>
                  {submitting ? "Creating..." : submitLabel}
                </button>
              </form>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
