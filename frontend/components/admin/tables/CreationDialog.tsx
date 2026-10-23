import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, BadgePlus, Loader2, X } from "lucide-react";
import styles from "../permissions/PermissionForm.module.css";

export function CreationDialog({
  triggerLabel,
  title,
  description,
  submitLabel,
  error,
  onOpen,
  onSubmit,
  children,
  triggerClassName,
  onOpenChange,
}: {
  triggerLabel: string;
  title: string;
  description: string;
  submitLabel: string;
  error?: string;
  onOpen?: () => void;
  onSubmit: () => Promise<boolean | void> | boolean | void;
  children: ReactNode;
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => { onOpenChange?.(open); }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <>
      <button
        className={`${styles.trigger} ${triggerClassName || ""}`.trim()}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        <BadgePlus size={17} aria-hidden="true" />
        {triggerLabel}
      </button>

      <dialog
        ref={dialogRef}
        className={`${styles.dialog} scrollable-content`}
        aria-labelledby="creation-dialog-title"
        onCancel={(event) => { event.preventDefault(); if (!submitting) setOpen(false); }}
        onClick={(event) => { if (event.target === event.currentTarget && !submitting) setOpen(false); }}
      >
        <form onSubmit={handleSubmit} className={styles.form}>
          <header className={styles.header}>
            <span className={styles.headerIcon} aria-hidden="true"><BadgePlus size={23} strokeWidth={1.7} /></span>
            <div><h2 id="creation-dialog-title">{title}</h2><p>{description}</p></div>
            <button className={styles.close} type="button" disabled={submitting} onClick={() => setOpen(false)} aria-label={`Close ${title.toLowerCase()}`}>
              <X size={19} />
            </button>
          </header>

          <div className={`${styles.body} scrollable-content`}>
            {children}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </div>

          <footer className={styles.footer}>
            <button className={styles.cancelButton} type="button" disabled={submitting} onClick={() => setOpen(false)}>Cancel</button>
            <button className={styles.submitButton} type="submit" disabled={submitting}>
              {submitting ? <><Loader2 size={16} className={styles.spinner} />Creating…</> : <>{submitLabel}<ArrowRight size={16} aria-hidden="true" /></>}
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
}
