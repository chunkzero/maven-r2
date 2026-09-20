import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";

export default defineConfig({
    plugins: [
        stylex.vite({
            unstable_moduleResolution: {
                type: "commonJS",
                rootDir: new URL(".", import.meta.url).pathname,
            },
        }),
        react(),
    ],
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            "/api": "http://127.0.0.1:8787",
            "/maven": "http://127.0.0.1:8787",
            "/health": "http://127.0.0.1:8787",
        },
    },
});
