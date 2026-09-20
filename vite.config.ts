import { defineConfig } from "vite-plus";

export default defineConfig({
    fmt: {
        tabWidth: 4,
        printWidth: 100,
        ignorePatterns: ["CLAUDE.md", "**/generated/**", "**/migrations/**", "pnpm-lock.yaml"],
    },
    lint: {
        plugins: ["typescript", "react", "react-hooks"],
        ignorePatterns: ["**/generated/**", "**/dist/**"],
        rules: { "typescript/no-explicit-any": "error" },
    },
});
