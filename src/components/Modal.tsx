import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type PropsWithChildren,
} from "react";

interface ModalProps extends PropsWithChildren {
  open: boolean;
  title: string;
  description?: string;
  size?: "default" | "wide";
  closeDisabled?: boolean;
  onClose(): void;
}

export function Modal({
  open,
  title,
  description,
  size = "default",
  closeDisabled = false,
  onClose,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    dialog.showModal();
    window.requestAnimationFrame(() => dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus());

    return () => {
      if (dialog.open) dialog.close();
      openerRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (!closeDisabled && event.target === event.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`modal-shell modal-shell--${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={handleBackdrop}
    >
      <div className="modal-panel">
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button
            className="icon-button"
            type="button"
            disabled={closeDisabled}
            onClick={onClose}
            aria-label={`关闭${title}`}
            title="关闭"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </dialog>
  );
}
