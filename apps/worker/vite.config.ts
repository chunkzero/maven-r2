import { defineConfig } from "vite-plus";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./test/wrangler.jsonc" },
            miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
        }),
    ],
    test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
