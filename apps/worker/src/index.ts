import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { AppEnv, Env } from "./env";
import { authenticate, fail, rateLimit } from "./security";
import { auth } from "./auth";
import { registerManagement } from "./management";
import { registerPublications } from "./publications";
import { registerDownloads, serveMappedRepository } from "./downloads";
import { registerBootstrap } from "./bootstrap";
import { cleanup } from "./cleanup";
export { RepositoryCoordinator } from "./coordinator";

export const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
        if (!result.success)
            fail(
                400,
                "Invalid request: " + result.error.issues.map((issue) => issue.message).join("; "),
            );
    },
});
app.use(
    "*",
    secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "https://avatars.githubusercontent.com", "data:"],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
        },
        referrerPolicy: "no-referrer",
    }),
);
app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("x-request-id", c.get("requestId"));
    await next();
    if (c.res.status === 401 && (c.req.path.startsWith("/maven/") || c.get("repositoryMapping")))
        c.header("www-authenticate", 'Basic realm="Maven R2"');
});
app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
        const origin = c.req.header("origin");
        if (origin && origin !== new URL(c.env.APP_URL).origin) fail(403, "Invalid request origin");
        if (!c.req.path.includes("/parts/")) {
            const limit = bodyLimit({
                maxSize: 128 * 1024,
                onError: () => {
                    fail(413, "Request body too large");
                },
            });
            return limit(c, next);
        }
    }
    await next();
});
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    await rateLimit(c.env, "auth:" + (c.req.header("cf-connecting-ip") ?? "local"), 60);
    const response = await auth(c.env).handler(c.req.raw);
    return new Response(response.body, response);
});
app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    c.set("principal", await authenticate(c.req.raw, c.env));
    if (c.req.path.startsWith("/api/") && !["GET", "HEAD"].includes(c.req.method))
        await rateLimit(
            c.env,
            (c.req.path.startsWith("/api/publications") ? "publish:" : "manage:") +
                (c.get("principal")?.actor ??
                    "ip:" + (c.req.header("cf-connecting-ip") ?? "local")),
            c.req.path.startsWith("/api/publications") ? 2400 : 120,
        );
    await next();
});
app.get("/health", async (c) => {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok" });
});
registerBootstrap(app);
registerManagement(app);
registerPublications(app);
registerDownloads(app);
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
});
app.doc("/api/openapi.json", {
    openapi: "3.0.3",
    info: { title: "Maven R2 publishing API", version: "1.0.0" },
});
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/maven/*", (c) => c.json({ error: "Publish through the local maven-r2 proxy" }, 405));
app.get("/", (c) => c.redirect(new URL("/console", c.env.APP_URL).href));
app.get("/invite/:secret", (c) => c.redirect(new URL("/console" + c.req.path, c.env.APP_URL).href));
app.on(["GET", "HEAD"], ["/console", "/console/*"], async (c) => {
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/console/assets/")) url.pathname = "/console/index.html";
    const response = await c.env.ASSETS.fetch(new Request(url, c.req.raw));
    return new Response(response.body, response);
});
for (const probe of ["/favicon.ico", "/robots.txt", "/.well-known/*"])
    app.all(probe, (c) => c.json({ error: "Not found" }, 404));
app.all("*", serveMappedRepository);
app.onError((error, c) => {
    const status =
        error instanceof HTTPException ? error.status : error instanceof ZodError ? 400 : 500;
    if (status === 500) console.error("Request failed", c.get("requestId"), error.message);
    if (status === 429) c.header("retry-after", "60");
    return c.json(
        {
            error: status === 500 ? "Internal error. Retry the request." : error.message,
            requestId: c.get("requestId"),
        },
        status,
    );
});
export default {
    fetch: app.fetch,
    scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(cleanup(env));
    },
} satisfies ExportedHandler<Env>;
