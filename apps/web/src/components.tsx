import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import {
    useEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type SelectHTMLAttributes,
    type TdHTMLAttributes,
    type TextareaHTMLAttributes,
} from "react";
import { LoaderCircle } from "lucide-react";
import { colors, fonts } from "./theme.stylex";

const NARROW = "@media (max-width: 640px)";
const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });

export const ui = stylex.create({
    muted: { color: colors.muted },
    mono: { fontFamily: fonts.mono, fontSize: 12.5 },
    h1: { fontSize: 22, fontWeight: 600, letterSpacing: -0.3, margin: 0 },
    h2: { fontSize: 15, fontWeight: 600, marginTop: 0, marginBottom: 12 },
    p: { margin: 0, lineHeight: 1.5 },
    link: {
        color: colors.fg,
        textDecorationLine: "underline",
        textDecorationColor: { default: colors.line, ":hover": colors.fg },
    },
    quietLink: {
        color: colors.muted,
        textDecorationLine: "none",
        ":hover": { color: colors.fg },
    },
    textButton: {
        backgroundColor: "transparent",
        borderStyle: "none",
        padding: 0,
        fontFamily: "inherit",
        fontSize: "inherit",
        color: colors.fg,
        cursor: "pointer",
        textAlign: "left",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        textDecorationLine: { default: "none", ":hover": "underline" },
    },
    button: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        paddingBlock: 7,
        paddingInline: 12,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.line,
        borderRadius: 6,
        backgroundColor: { default: colors.bg, ":hover": colors.soft },
        color: colors.fg,
        fontFamily: "inherit",
        fontSize: "inherit",
        fontWeight: 500,
        lineHeight: 1.5,
        textDecorationLine: "none",
        cursor: { default: "pointer", ":disabled": "default" },
        opacity: { default: 1, ":disabled": 0.5 },
    },
    primary: {
        backgroundColor: colors.fg,
        borderColor: colors.fg,
        color: colors.bg,
        opacity: { default: 1, ":hover": 0.85, ":disabled": 0.5 },
    },
    small: { paddingBlock: 4, paddingInline: 9, fontSize: 12.5 },
    input: {
        fontFamily: "inherit",
        fontSize: "inherit",
        color: colors.fg,
        backgroundColor: colors.bg,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.line,
        borderRadius: 6,
        paddingBlock: 7,
        paddingInline: 10,
        width: "100%",
        maxWidth: "100%",
    },
    auto: { width: "auto" },
    textarea: { resize: "vertical" },
    field: {
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginBottom: 14,
        fontSize: 13,
        fontWeight: 500,
        flex: 1,
        minWidth: 0,
    },
    hint: { fontWeight: 400, fontSize: 12, color: colors.muted },
    row: {
        display: "flex",
        gap: { default: 14, [NARROW]: 0 },
        flexDirection: { default: "row", [NARROW]: "column" },
    },
    fieldset: {
        borderStyle: "none",
        padding: 0,
        marginBottom: 14,
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 18px",
    },
    legend: { fontSize: 13, fontWeight: 500, padding: 0, marginBottom: 6 },
    check: { display: "flex", alignItems: "center", gap: 8 },
    footer: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        marginTop: 20,
    },
    badge: {
        display: "inline-block",
        paddingBlock: 1,
        paddingInline: 8,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.line,
        borderRadius: 10,
        fontSize: 12,
    },
    notice: {
        margin: 0,
        paddingBlock: 10,
        paddingInline: 14,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.fg,
        borderRadius: 6,
    },
    code: {
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        paddingBlock: 10,
        paddingInline: 12,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.line,
        borderRadius: 6,
        marginBlock: 8,
    },
    pre: {
        flex: 1,
        margin: 0,
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        fontFamily: fonts.mono,
        fontSize: 12.5,
    },
    dialog: {
        width: "min(540px, calc(100vw - 32px))",
        maxHeight: "90vh",
        padding: 24,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.line,
        borderRadius: 10,
        backgroundColor: colors.bg,
        color: colors.fg,
        "::backdrop": { backgroundColor: "rgba(0, 0, 0, 0.5)" },
    },
    heading: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        marginBottom: 16,
    },
    h2Modal: { margin: 0, fontSize: 17 },
    dl: {
        display: "grid",
        gridTemplateColumns: { default: "max-content 1fr", [NARROW]: "1fr" },
        gap: "8px 16px",
        alignItems: "baseline",
        margin: 0,
    },
    dt: { color: colors.muted, fontSize: 13 },
    dd: { margin: 0, minWidth: 0, overflowWrap: "anywhere" },
    scroll: {
        overflowX: "auto",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: colors.line,
        borderRadius: 8,
    },
    table: { width: "100%", borderCollapse: "collapse" },
    th: {
        textAlign: "left",
        paddingBlock: 10,
        paddingInline: 14,
        fontSize: 12,
        fontWeight: 500,
        color: colors.muted,
    },
    td: {
        textAlign: "left",
        paddingBlock: 10,
        paddingInline: 14,
        borderTopWidth: 1,
        borderTopStyle: "solid",
        borderTopColor: colors.line,
        verticalAlign: "top",
    },
    right: { textAlign: "right", whiteSpace: "nowrap" },
    empty: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        paddingBlock: 24,
        margin: 0,
        color: colors.muted,
    },
    pageHeader: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
    },
    actions: { display: "flex", gap: 8 },
    toolbar: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 12,
    },
    progress: { width: "100%", accentColor: colors.fg },
    spin: {
        animationName: spin,
        animationDuration: "1s",
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
    },
});

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

type Sx = { sx?: StyleXStyles };
type Native<T> = Omit<T, "className" | "style">;
export function Button({
    primary,
    small,
    sx,
    ...props
}: Native<ButtonHTMLAttributes<HTMLButtonElement>> & Sx & { primary?: boolean; small?: boolean }) {
    return (
        <button
            {...props}
            {...stylex.props(ui.button, primary && ui.primary, small && ui.small, sx)}
        />
    );
}
export function Input({ sx, ...props }: Native<InputHTMLAttributes<HTMLInputElement>> & Sx) {
    return <input {...props} {...stylex.props(ui.input, sx)} />;
}
export function Select({ sx, ...props }: Native<SelectHTMLAttributes<HTMLSelectElement>> & Sx) {
    return <select {...props} {...stylex.props(ui.input, sx)} />;
}
export function Textarea(props: Native<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
    return <textarea {...props} {...stylex.props(ui.input, ui.textarea)} />;
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
        <label {...stylex.props(ui.field)}>
            <span>{label}</span>
            {children}
            {hint && <span {...stylex.props(ui.hint)}>{hint}</span>}
        </label>
    );
}
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
    return (
        <div {...stylex.props(ui.scroll)}>
            <table {...stylex.props(ui.table)}>
                <thead>
                    <tr>
                        {head.map((label, index) => (
                            <th key={index} {...stylex.props(ui.th)}>
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}
export function Td({
    right,
    muted,
    ...props
}: Native<TdHTMLAttributes<HTMLTableCellElement>> & { right?: boolean; muted?: boolean }) {
    return <td {...props} {...stylex.props(ui.td, right && ui.right, muted && ui.muted)} />;
}
export function Badge({ children }: { children: ReactNode }) {
    return <span {...stylex.props(ui.badge)}>{children}</span>;
}
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
    return (
        <header {...stylex.props(ui.pageHeader)}>
            <h1 {...stylex.props(ui.h1)}>{title}</h1>
            {children && <div {...stylex.props(ui.actions)}>{children}</div>}
        </header>
    );
}
export function Empty({ children }: { children: ReactNode }) {
    return <p {...stylex.props(ui.empty)}>{children}</p>;
}
export function Loading() {
    return (
        <p {...stylex.props(ui.empty)} role="status">
            <LoaderCircle {...stylex.props(ui.spin)} size={16} /> Loading…
        </p>
    );
}
export function ErrorNotice({ error }: { error: Error | null | undefined }) {
    return error ? (
        <p {...stylex.props(ui.notice)} role="alert">
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
        <Button
            type="button"
            small
            onClick={() =>
                navigator.clipboard.writeText(value).then(
                    () => setState("copied"),
                    () => setState("failed"),
                )
            }
        >
            {state === "failed" ? "Copy manually" : state === "copied" ? "Copied" : "Copy"}
        </Button>
    );
}
export function Code({ children }: { children: string }) {
    return (
        <div {...stylex.props(ui.code)}>
            <pre {...stylex.props(ui.pre)}>{children}</pre>
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
        <dialog ref={ref} onCancel={onClose} aria-label={title} {...stylex.props(ui.dialog)}>
            <div {...stylex.props(ui.heading)}>
                <h2 {...stylex.props(ui.h2Modal)}>{title}</h2>
                <Button type="button" small aria-label="Close dialog" onClick={onClose}>
                    Close
                </Button>
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
            <p {...stylex.props(ui.p)}>{children}</p>
            <ErrorNotice error={error} />
            <div {...stylex.props(ui.footer)}>
                <Button type="button" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" primary disabled={pending} onClick={onConfirm}>
                    {action}
                </Button>
            </div>
        </Modal>
    );
}
