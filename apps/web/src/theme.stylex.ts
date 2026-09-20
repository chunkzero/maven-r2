import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
    bg: { default: "#ffffff", "@media (prefers-color-scheme: dark)": "#0b0b0b" },
    fg: { default: "#111111", "@media (prefers-color-scheme: dark)": "#f2f2f2" },
    muted: { default: "#6b6b6b", "@media (prefers-color-scheme: dark)": "#9a9a9a" },
    line: { default: "#e3e3e3", "@media (prefers-color-scheme: dark)": "#2a2a2a" },
    soft: { default: "#f4f4f4", "@media (prefers-color-scheme: dark)": "#181818" },
});
export const fonts = stylex.defineVars({
    sans: '"DM Sans Variable", system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
});
