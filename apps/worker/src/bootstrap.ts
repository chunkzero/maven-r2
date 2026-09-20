import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "./env";
import { fail, hash, newSecret } from "./security";
import { timingSafeEqual } from "node:crypto";

export function registerBootstrap(app: OpenAPIHono<AppEnv>) {
    app.post("/api/bootstrap", async (c) => {
        const supplied = c.req.header("x-bootstrap-token") ?? "";
        if (
            !c.env.BOOTSTRAP_TOKEN ||
            !timingSafeEqual(
                Buffer.from(await hash(supplied)),
                Buffer.from(await hash(c.env.BOOTSTRAP_TOKEN)),
            )
        )
            fail(403, "Invalid bootstrap credential");
        if (await c.env.DB.prepare("SELECT id FROM accounts LIMIT 1").first())
            fail(409, "Instance is already initialized");
        const account = crypto.randomUUID(),
            service = crypto.randomUUID(),
            token = crypto.randomUUID(),
            secret = newSecret(),
            now = Date.now();
        await c.env.DB.batch([
            c.env.DB.prepare(
                "INSERT INTO accounts (id,slug,name,max_bytes,created_at) VALUES (?,?,?,?,?)",
            ).bind(
                account,
                c.env.DEFAULT_ACCOUNT_SLUG,
                c.env.DEFAULT_ACCOUNT_NAME,
                Number(c.env.MAX_ACCOUNT_BYTES),
                now,
            ),
            ...["releases", "snapshots"].map((policy) =>
                c.env.DB.prepare(
                    "INSERT INTO repositories (id,account_id,slug,name,visibility,policy,max_file_bytes,retention_days,created_at) VALUES (?,?,?,?,'private',?,?,?,?)",
                ).bind(
                    crypto.randomUUID(),
                    account,
                    policy,
                    policy === "releases" ? "Releases" : "Snapshots",
                    policy,
                    Number(c.env.MAX_FILE_BYTES),
                    policy === "snapshots" ? 30 : 0,
                    now,
                ),
            ),
            c.env.DB.prepare(
                "INSERT INTO service_accounts (id,account_id,name,role) VALUES (?,?,?,'publisher')",
            ).bind(service, account, "Bootstrap publisher"),
            c.env.DB.prepare(
                "INSERT INTO tokens (id,account_id,service_account_id,name,prefix,hash,scopes,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ).bind(
                token,
                account,
                service,
                "Bootstrap publisher",
                secret.slice(0, 12),
                await hash(secret),
                JSON.stringify(
                    ["releases", "snapshots"].map((repository) => ({
                        repository,
                        prefixes: [""],
                        actions: [
                            "read",
                            repository === "releases" ? "publish:release" : "publish:snapshot",
                        ],
                    })),
                ),
                now + 24 * 60 * 60 * 1000,
                now,
            ),
        ]);
        return c.json(
            {
                account: c.env.DEFAULT_ACCOUNT_SLUG,
                token: secret,
                expiresAt: now + 24 * 60 * 60 * 1000,
            },
            201,
        );
    });
}
