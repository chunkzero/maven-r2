import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle, X } from "lucide-react";

export function bytes(value: number) {
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let i = -1;
    do {
        value /= 1024;
        i++;
    } while (value >= 1024 && i < units.length - 1);
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
export function date(value: number) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        value,
    );
}
export function Badge({
    children,
    tone = "neutral",
}: {
    children: ReactNode;
    tone?: "neutral" | "green" | "amber";
}) {
    return <span className={`badge ${tone}`}>{children}</span>;
}
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
    return (
        <header className="page-header">
            <h1>{title}</h1>
            {children && <div className="actions">{children}</div>}
        </header>
    );
}
export function Empty({ children }: { children: ReactNode }) {
    return <p className="empty">{children}</p>;
}
export function Loading() {
    return (
        <p className="empty" role="status">
            <LoaderCircle className="spin" size={16} /> Loading…
        </p>
    );
}
export function ErrorNotice({ error }: { error: Error | null | undefined }) {
    return error ? (
        <p className="notice error" role="alert">
            {error.message}
        </p>
    ) : null;
}
export function CopyButton({ value }: { value: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    useEffect(() => {
        if (state === "idle") return;
        const timeout = setTimeout(() => setState("idle"), 2000);
        return () => clearTimeout(timeout);
    }, [state]);
    return (
        <button
            type="button"
            className="button small"
            aria-label="Copy"
            onClick={() =>
                navigator.clipboard.writeText(value).then(
                    () => setState("copied"),
                    () => setState("failed"),
                )
            }
        >
            {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
            {state === "failed" ? "Copy manually" : state === "copied" ? "Copied" : "Copy"}
        </button>
    );
}
export function Code({ children }: { children: string }) {
    return (
        <div className="code">
            <pre>{children}</pre>
            <CopyButton value={children} />
        </div>
    );
}
export function Modal({
    title,
    children,
    onClose,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const dialog = ref.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);
    return (
        <dialog ref={ref} onCancel={onClose} aria-label={title}>
            <div className="modal-heading">
                <h2>{title}</h2>
                <button
                    type="button"
                    className="button small"
                    aria-label="Close dialog"
                    onClick={onClose}
                >
                    <X size={15} />
                </button>
            </div>
            {children}
        </dialog>
    );
}
export function Confirm({
    title,
    action,
    children,
    pending,
    error,
    onConfirm,
    onClose,
}: {
    title: string;
    action: string;
    children: ReactNode;
    pending: boolean;
    error: Error | null;
    onConfirm: () => void;
    onClose: () => void;
}) {
    return (
        <Modal title={title} onClose={onClose}>
            <p>{children}</p>
            <ErrorNotice error={error} />
            <div className="form-footer">
                <button type="button" className="button" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="button danger"
                    disabled={pending}
                    onClick={onConfirm}
                >
                    {action}
                </button>
            </div>
        </Modal>
    );
}
export function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: ReactNode;
}) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
            {hint && <small>{hint}</small>}
        </label>
    );
}
