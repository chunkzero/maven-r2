import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle, PackageOpen, X, AlertCircle } from "lucide-react";

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
export function PageTitle({
    eyebrow,
    title,
    description,
    action,
}: {
    eyebrow?: string;
    title: string;
    description: string;
    action?: ReactNode;
}) {
    return (
        <header className="page-title">
            <div>
                {eyebrow && <div className="eyebrow">{eyebrow}</div>}
                <h1>{title}</h1>
                <p>{description}</p>
            </div>
            {action}
        </header>
    );
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="empty">
            <div className="empty-icon">
                <PackageOpen size={28} />
            </div>
            <h3>{title}</h3>
            <p>{children}</p>
        </div>
    );
}
export function Loading() {
    return (
        <div className="loading" role="status">
            <LoaderCircle className="spin" size={20} /> Loading…
        </div>
    );
}
export function ErrorNotice({ error }: { error: Error | null | undefined }) {
    return error ? (
        <div className="notice error" role="alert">
            <AlertCircle size={18} />
            <span>{error.message}</span>
        </div>
    ) : null;
}
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
    const [copied, setCopied] = useState(false),
        [error, setError] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timeout = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(timeout);
    }, [copied]);
    return (
        <button
            type="button"
            className="button subtle small"
            onClick={() => {
                navigator.clipboard.writeText(value).then(
                    () => {
                        setCopied(true);
                        setError(false);
                    },
                    () => setError(true),
                );
            }}
        >
            {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
            {error ? "Select and copy manually" : copied ? "Copied" : label}
        </button>
    );
}
export function Code({ children }: { children: string }) {
    return (
        <div className="code">
            <CopyButton value={children} />
            <pre>{children}</pre>
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
                    className="icon-button"
                    aria-label="Close dialog"
                    onClick={onClose}
                >
                    <X size={20} />
                </button>
            </div>
            {children}
        </dialog>
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
