import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";

export default defineConfig({
    base: "/console/",
    build: { outDir: "dist/console" },
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
            // Serve the console page at / and forward every other non-console path to the Worker
            // with the original host, so origin-relative repository mappings resolve locally.
            "^/(?!console(?:/|$))": {
                target: "http://127.0.0.1:8787",
                bypass: (req) => (req.url === "/" ? "/console/" : undefined),
            },
        },
    },
});
