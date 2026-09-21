import { createHmac } from "node:crypto";
import { auth } from "../src/auth";
import { cleanup } from "../src/cleanup";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { hash, newSecret } from "../src/security";
import { parseMetadata } from "../src/metadata";
import { PART_SIZE } from "../src/storage";
import { matchRepositoryMapping } from "../src/repository-mappings";
import type { Publication, Upload } from "@maven-r2/contracts";

let token: string;
function request(path: string, method = "GET", body?: unknown, secret = token) {
    const headers: Record<string, string> = {};
    if (secret) headers.authorization = "Bearer " + secret;
    if (body !== undefined) headers["content-type"] = "application/json";
    return app.request(
        "https://repo.test" + path,
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
        env,
    );
}
async function json<T>(response: Response, expected = 200): Promise<T> {
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(expected);
    return data as T;
}
async function begin(repository = "releases") {
    return json<Publication>(
        await request("/api/publications", "POST", { account: "test", repository, label: "test" }),
        201,
    );
}
async function stage(session: string, path: string, content: string | Uint8Array<ArrayBuffer>) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
    const upload = await json<Upload>(
        await request(`/api/publications/${session}/uploads`, "POST", {
            path,
            size: bytes.length,
            sha256,
        }),
    );
    for (
        let offset = 0, part = 1;
        offset < bytes.length || part === 1;
        offset += PART_SIZE, part++
    ) {
        const body = bytes.slice(offset, offset + PART_SIZE);
        const result = await app.request(
            `https://repo.test/api/publications/${session}/uploads/${upload.id}/parts/${part}`,
            {
                method: "PUT",
                headers: {
                    authorization: "Bearer " + token,
                    "content-length": String(body.length),
                },
                body,
            },
            env,
        );
        await json(result);
    }
    await json(await request(`/api/publications/${session}/uploads/${upload.id}/complete`, "POST"));
    return upload;
}
function pom(version: string, artifact = "demo") {
    return `<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>${artifact}</artifactId><version>${version}</version></project>`;
}
async function release(version = "1.0", content = "artifact") {
    const session = await begin();
    await stage(session.id, `com/acme/demo/${version}/demo-${version}.pom`, pom(version));
    await stage(session.id, `com/acme/demo/${version}/demo-${version}.jar`, content);
    return session;
}
beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const response = await app.request(
        "https://repo.test/api/bootstrap",
        { method: "POST", headers: { "x-bootstrap-token": "test-bootstrap-secret" } },
        env,
    );
    token = (await json<{ token: string }>(response, 201)).token;
});

describe("publication and Maven protocol", () => {
    it("keeps staged releases private and exposes artifacts, metadata and checksums together", async () => {
        const session = await release();
        const path = "/maven/test/releases/com/acme/demo/1.0/demo-1.0.jar";
        expect((await request(path)).status).toBe(404);
        expect(
            (
                await request(
                    `/api/publications/${session.id}/files?path=com/acme/demo/1.0/demo-1.0.jar`,
                )
            ).status,
        ).toBe(200);
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        const file = await request(path);
        expect(await file.text()).toBe("artifact");
        expect((await request(path, "GET", undefined, "")).status).toBe(401);
        expect(await (await request(path + ".sha256")).text()).toBe(await hash("artifact"));
        const metadata = parseMetadata(
            await (await request("/maven/test/releases/com/acme/demo/maven-metadata.xml")).text(),
        );
        expect(metadata.versioning?.versions?.version).toEqual(["1.0"]);
        const range = await app.request(
            "https://repo.test" + path,
            { headers: { authorization: "Bearer " + token, range: "bytes=1-3" } },
            env,
        );
        expect(range.status).toBe(206);
        expect(await range.text()).toBe("rti");
        expect((await request(path, "HEAD")).headers.get("content-length")).toBe("8");
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
    });
    it("merges concurrent version publications and rejects release overwrites", async () => {
        const one = await release("1.0"),
            two = await release("2.0");
        await Promise.all(
            [one, two].map(async (session) =>
                json(await request(`/api/publications/${session.id}/commit`, "POST")),
            ),
        );
        const metadata = parseMetadata(
            await (await request("/maven/test/releases/com/acme/demo/maven-metadata.xml")).text(),
        );
        expect(metadata.versioning?.versions?.version).toEqual(
            expect.arrayContaining(["1.0", "2.0"]),
        );
        const conflict = await release("1.0", "different");
        expect((await request(`/api/publications/${conflict.id}/commit`, "POST")).status).toBe(409);
        expect(
            await (await request("/maven/test/releases/com/acme/demo/1.0/demo-1.0.jar")).text(),
        ).toBe("artifact");
    });
    it("aborts failed publications and releases their quota reservations", async () => {
        const session = await release();
        await json(await request(`/api/publications/${session.id}`, "DELETE"));
        const account = await env.DB.prepare(
            "SELECT reserved_bytes,used_bytes FROM accounts",
        ).first();
        expect(account).toMatchObject({ reserved_bytes: 0, used_bytes: 0 });
        expect((await request(`/api/publications/${session.id}/commit`, "POST")).status).toBe(409);
    });
    it("rejects mismatched sidecar checksums without publishing any files", async () => {
        const session = await release();
        await stage(session.id, "com/acme/demo/1.0/demo-1.0.jar.sha1", "0".repeat(40));
        expect((await request(`/api/publications/${session.id}/commit`, "POST")).status).toBe(400);
        expect((await request("/maven/test/releases/com/acme/demo/1.0/demo-1.0.jar")).status).toBe(
            404,
        );
    });
    it("lets reactor builds re-stage group metadata while artifacts stay fixed", async () => {
        const session = await begin();
        await stage(session.id, "com/acme/demo/1.0/demo-1.0.pom", pom("1.0"));
        await stage(session.id, "com/acme/demo/1.0/demo-1.0.jar", "artifact");
        const plugins = (prefixes: string[]) =>
            `<metadata><plugins>${prefixes
                .map(
                    (prefix) =>
                        `<plugin><prefix>${prefix}</prefix><artifactId>demo</artifactId></plugin>`,
                )
                .join("")}</plugins></metadata>`;
        await stage(session.id, "com/acme/maven-metadata.xml", plugins(["one"]));
        await stage(session.id, "com/acme/maven-metadata.xml", plugins(["one", "two"]));
        const conflict = await request(`/api/publications/${session.id}/uploads`, "POST", {
            path: "com/acme/demo/1.0/demo-1.0.jar",
            size: 9,
            sha256: "0".repeat(64),
        });
        expect(conflict.status).toBe(409);
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        const metadata = parseMetadata(
            await (await request("/maven/test/releases/com/acme/maven-metadata.xml")).text(),
        );
        expect(metadata.plugins?.plugin.map((plugin) => plugin.prefix)).toEqual(["one", "two"]);
        expect(await env.DB.prepare("SELECT reserved_bytes FROM accounts").first()).toMatchObject({
            reserved_bytes: 0,
        });
    });
    it("resolves timestamped snapshots from server-generated metadata", async () => {
        const session = await begin("snapshots");
        const root = "com/acme/demo/1.0-SNAPSHOT/demo-1.0-20260920.120000-1";
        await stage(session.id, root + ".pom", pom("1.0-SNAPSHOT"));
        await stage(session.id, root + ".jar", "snapshot");
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        const metadata = parseMetadata(
            await (
                await request("/maven/test/snapshots/com/acme/demo/1.0-SNAPSHOT/maven-metadata.xml")
            ).text(),
        );
        expect(metadata.versioning?.snapshot).toMatchObject({
            timestamp: "20260920.120000",
            buildNumber: "1",
        });
        expect(
            metadata.versioning?.snapshotVersions?.snapshotVersion.find(
                (item) => item.extension === "jar",
            )?.value,
        ).toBe("1.0-20260920.120000-1");
    });
    it("uploads and verifies multipart artifacts", async () => {
        const session = await begin();
        await stage(session.id, "com/acme/demo/1.0/demo-1.0.pom", pom("1.0"));
        await stage(
            session.id,
            "com/acme/demo/1.0/demo-1.0.jar",
            new Uint8Array(PART_SIZE + 8).fill(7),
        );
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        expect(
            (
                await request("/maven/test/releases/com/acme/demo/1.0/demo-1.0.jar", "HEAD")
            ).headers.get("content-length"),
        ).toBe(String(PART_SIZE + 8));
    });
    it("enforces namespace boundaries, expiry and service account revocation", async () => {
        const row = await env.DB.prepare("SELECT * FROM tokens").first<{
            id: string;
            service_account_id: string;
        }>();
        await env.DB.prepare("UPDATE tokens SET scopes=? WHERE id=?")
            .bind(
                JSON.stringify([
                    {
                        repository: "releases",
                        prefixes: ["com/acme"],
                        actions: ["read", "publish:release"],
                    },
                ]),
                row!.id,
            )
            .run();
        const session = await begin();
        const denied = await request(`/api/publications/${session.id}/uploads`, "POST", {
            path: "com/acmeevil/demo/1.0/demo-1.0.jar",
            size: 1,
            sha256: await hash("x"),
        });
        expect(denied.status).toBe(403);
        await env.DB.prepare("UPDATE service_accounts SET disabled=1 WHERE id=?")
            .bind(row!.service_account_id)
            .run();
        expect((await request(`/api/publications/${session.id}`)).status).toBe(401);
    });
    it("does not allow a valid token to cross account boundaries", async () => {
        await env.DB.prepare(
            "INSERT INTO accounts (id,slug,name,max_bytes,created_at) VALUES ('other','other','Other',10000,0)",
        ).run();
        await env.DB.prepare(
            "INSERT INTO repositories (id,account_id,slug,name,visibility,policy,max_file_bytes,created_at) VALUES ('other','other','releases','Other','private','releases',10000,0)",
        ).run();
        expect(
            (
                await request("/api/publications", "POST", {
                    account: "other",
                    repository: "releases",
                })
            ).status,
        ).toBe(403);
        expect((await request("/maven/other/releases/com/acme/demo/1.0/demo-1.0.jar")).status).toBe(
            403,
        );
        expect(
            (
                await request(
                    "/api/publications",
                    "POST",
                    { account: "test", repository: "releases" },
                    newSecret(),
                )
            ).status,
        ).toBe(401);
    });
});

describe("repository URL mappings", () => {
    function runtime() {
        return {
            ...env,
            REPOSITORY_MAPPINGS: [
                { url: "/", account: "test", repository: "releases" },
                { url: "/snapshots/", account: "test", repository: "snapshots" },
            ],
        };
    }

    it("resolves relative mappings against APP_URL and serves public artifacts anonymously", async () => {
        const session = await release();
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        await env.DB.prepare("UPDATE repositories SET visibility='public'").run();
        const mapped = runtime();
        const path = "/com/acme/demo/1.0/demo-1.0.jar";
        expect(await (await app.request("https://repo.test" + path, {}, mapped)).text()).toBe(
            "artifact",
        );
        expect((await app.request("https://other.test" + path, {}, mapped)).status).toBe(404);
        expect((await app.request("https://repo.test/", {}, mapped)).status).toBe(302);
        expect((await app.request("https://repo.test/snapshots", {}, mapped)).status).toBe(404);
        expect(
            await json(
                await app.request("https://repo.test/api/accounts/test/repositories", {}, mapped),
            ),
        ).toMatchObject([
            { slug: "releases", url: "https://repo.test" },
            { slug: "snapshots", url: "https://repo.test/snapshots" },
        ]);
    });

    it("serves root and snapshot aliases with the existing Maven download semantics", async () => {
        const releaseSession = await release();
        await json(await request(`/api/publications/${releaseSession.id}/commit`, "POST"));
        const snapshotSession = await begin("snapshots");
        const snapshot = "com/acme/demo/1.0-SNAPSHOT/demo-1.0-20260920.120000-1";
        await stage(snapshotSession.id, snapshot + ".pom", pom("1.0-SNAPSHOT"));
        await stage(snapshotSession.id, snapshot + ".jar", "snapshot");
        await json(await request(`/api/publications/${snapshotSession.id}/commit`, "POST"));
        const get = (path: string, init: RequestInit = {}) =>
            app.request(
                "https://repo.test" + path,
                {
                    ...init,
                    headers: { authorization: "Basic " + btoa("maven:" + token), ...init.headers },
                },
                runtime(),
            );
        const path = "/com/acme/demo/1.0/demo-1.0.jar";
        const artifact = await get(path);
        expect(artifact.status).toBe(200);
        expect(await artifact.text()).toBe("artifact");
        expect(await (await get(path + ".sha256")).text()).toBe(await hash("artifact"));
        expect((await get(path, { method: "HEAD" })).headers.get("content-length")).toBe("8");
        const range = await get(path, { headers: { range: "bytes=1-3" } });
        expect(range.status).toBe(206);
        expect(await range.text()).toBe("rti");
        expect(
            (await get(path, { headers: { "if-none-match": artifact.headers.get("etag")! } }))
                .status,
        ).toBe(304);
        expect(await (await get("/snapshots/" + snapshot + ".jar")).text()).toBe("snapshot");
        expect(await (await get("/%73napshots/" + snapshot + ".jar")).text()).toBe("snapshot");
        expect((await get("/snapshots/com/acme/demo/1.0-SNAPSHOT/maven-metadata.xml")).status).toBe(
            200,
        );
        expect((await get("/snapshots" + path)).status).toBe(404);
        expect((await get("/snapshots-other" + path)).status).toBe(404);
        expect((await get(path, { method: "PUT" })).status).toBe(405);
        expect(await (await get("/maven/test/releases" + path)).text()).toBe("artifact");
    });

    it("preserves token scopes, revocation, visibility and account isolation in multi mode", async () => {
        const session = await release();
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        await env.DB.batch([
            env.DB.prepare(
                "INSERT INTO accounts (id,slug,name,max_bytes,created_at) VALUES ('other','other','Other',10000,0)",
            ),
            env.DB.prepare(
                "INSERT INTO repositories (id,account_id,slug,name,visibility,policy,max_file_bytes,created_at) VALUES ('other','other','releases','Other','private','releases',10000,0)",
            ),
        ]);
        const base = runtime();
        const mapped = {
            ...base,
            INSTANCE_MODE: "multi" as const,
            REPOSITORY_MAPPINGS: [
                ...base.REPOSITORY_MAPPINGS,
                { url: "https://other.test", account: "other", repository: "releases" },
            ],
        };
        const path = "/com/acme/demo/1.0/demo-1.0.jar";
        const get = (origin: string, secret = token) =>
            app.request(
                origin + path,
                {
                    headers: secret ? { authorization: "Bearer " + secret } : {},
                },
                mapped,
            );
        const anonymous = await get("https://repo.test", "");
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get("www-authenticate")).toBe('Basic realm="Maven R2"');
        expect((await get("https://other.test")).status).toBe(403);
        await env.DB.prepare("UPDATE tokens SET scopes=?")
            .bind(
                JSON.stringify([
                    { repository: "releases", prefixes: ["com/elsewhere"], actions: ["read"] },
                ]),
            )
            .run();
        expect((await get("https://repo.test")).status).toBe(403);
        await env.DB.prepare(
            "UPDATE repositories SET visibility='public' WHERE account_id!='other'",
        ).run();
        expect((await get("https://repo.test", "")).status).toBe(200);
        await env.DB.prepare("UPDATE tokens SET revoked=1").run();
        expect((await get("https://repo.test")).status).toBe(401);
        await env.DB.prepare("UPDATE accounts SET suspended=1 WHERE slug='test'").run();
        expect((await get("https://repo.test", "")).status).toBe(404);
    });

    it("advertises the first mapped URL and retains canonical URLs for unmapped repositories", async () => {
        const mapped = {
            ...env,
            REPOSITORY_MAPPINGS: [
                { url: "https://maven.test/", account: "test", repository: "releases" },
                { url: "https://alternate.test/releases", account: "test", repository: "releases" },
            ],
        };
        const response = await app.request(
            "https://repo.test/api/accounts/test/repositories",
            {
                headers: { authorization: "Bearer " + token },
            },
            mapped,
        );
        expect(await json(response)).toMatchObject([
            { slug: "releases", url: "https://maven.test" },
            { slug: "snapshots", url: "https://repo.test/maven/test/snapshots" },
        ]);
        expect(
            (await app.request("https://unmapped.test/com/acme/demo/1.0/demo-1.0.jar", {}, mapped))
                .status,
        ).toBe(404);
    });

    it("keeps console and API requests out of root mappings and never serves HTML for missing artifacts", async () => {
        const mapped = {
            ...runtime(),
            ASSETS: {
                fetch: async (request: Request) => new Response(new URL(request.url).pathname),
            } as Fetcher,
        };
        expect((await app.request("https://other.test/", {}, mapped)).headers.get("location")).toBe(
            "https://repo.test/console",
        );
        expect(
            await (
                await app.request(
                    "https://repo.test/console/test/repositories/releases",
                    {},
                    mapped,
                )
            ).text(),
        ).toBe("/console/index.html");
        expect(
            await (await app.request("https://repo.test/console/assets/app.js", {}, mapped)).text(),
        ).toBe("/console/assets/app.js");
        expect(
            (await app.request("https://other.test/invite/example", {}, mapped)).headers.get(
                "location",
            ),
        ).toBe("https://repo.test/console/invite/example");
        const favicon = await app.request("https://repo.test/favicon.ico", {}, mapped);
        expect(favicon.status).toBe(404);
        expect(favicon.headers.has("www-authenticate")).toBe(false);
        expect((await app.request("https://repo.test/api/config", {}, mapped)).status).toBe(200);
        const deniedApi = await app.request(
            "https://repo.test/api/accounts/test/tokens",
            {},
            mapped,
        );
        expect(deniedApi.status).toBe(401);
        expect(deniedApi.headers.has("www-authenticate")).toBe(false);
        const missing = await app.request(
            "https://repo.test/com/acme/missing.jar",
            {
                headers: { authorization: "Bearer " + token, "sec-fetch-mode": "navigate" },
            },
            mapped,
        );
        expect(missing.status).toBe(404);
        expect(missing.headers.get("content-type")).toContain("application/json");
    });

    it("rejects duplicate, reserved and unsafe mapping URLs", () => {
        for (const url of [
            "https://repo.test/api/releases",
            "https://repo.test/console",
            "https://repo.test/maven",
            "https://repo.test/releases?token=secret",
            "https://user:secret@repo.test",
            "http://repo.test",
            "/api",
            "/console/releases",
            "snapshots",
            "//evil.test/releases",
            "/releases?token=secret",
        ]) {
            expect(() =>
                matchRepositoryMapping(
                    {
                        ...env,
                        REPOSITORY_MAPPINGS: [{ url, account: "test", repository: "releases" }],
                    },
                    new URL("https://repo.test/com/acme/file.jar"),
                ),
            ).toThrow();
        }
        expect(() =>
            matchRepositoryMapping(
                {
                    ...env,
                    REPOSITORY_MAPPINGS: [
                        { url: "https://repo.test/", account: "test", repository: "releases" },
                        { url: "/", account: "test", repository: "snapshots" },
                    ],
                },
                new URL("https://repo.test/com/acme/file.jar"),
            ),
        ).toThrow("Duplicate repository mapping");
    });
});

async function browserUser(id = "owner", email = "owner@example.com", admin = true, runtime = env) {
    const now = Date.now(),
        sessionToken = "session-" + id;
    await env.DB.batch([
        env.DB.prepare(
            "INSERT INTO auth_users (id,name,email,email_verified,github_id,created_at,updated_at) VALUES (?,?,?,1,?,?,?)",
        ).bind(id, id, email, admin ? "42" : null, now, now),
        env.DB.prepare(
            "INSERT INTO auth_sessions (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        ).bind(id, sessionToken, id, now + 3600000, now, now),
    ]);
    const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
        .update(sessionToken)
        .digest("base64");
    const cookie =
        "__Secure-better-auth.session_token=" + encodeURIComponent(sessionToken + "." + signature);
    return (path: string, method = "GET", body?: unknown) =>
        app.request(
            "https://repo.test" + path,
            {
                method,
                headers: {
                    cookie,
                    origin: "https://repo.test",
                    "content-type": "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            },
            runtime,
        );
}

describe("account management and lifecycle", () => {
    it("starts OIDC sign-in through the social endpoint with the configured callback", async () => {
        const discovery = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
            Response.json({
                issuer: "https://idp.test",
                authorization_endpoint: "https://idp.test/authorize",
                token_endpoint: "https://idp.test/token",
                userinfo_endpoint: "https://idp.test/userinfo",
            }),
        );
        try {
            const response = await app.request(
                "https://repo.test/api/auth/sign-in/social",
                {
                    method: "POST",
                    headers: { origin: "https://repo.test", "content-type": "application/json" },
                    body: JSON.stringify({
                        provider: "oidc",
                        callbackURL: "https://repo.test/test",
                    }),
                },
                {
                    ...env,
                    OIDC_DISCOVERY_URL: "https://idp.test/.well-known/openid-configuration",
                    OIDC_CLIENT_ID: "test-client",
                    OIDC_CLIENT_SECRET: "test-client-secret",
                },
            );
            const result = await json<{ url: string; redirect: boolean }>(response);
            const url = new URL(result.url);
            expect(result.redirect).toBe(true);
            expect(url.origin + url.pathname).toBe("https://idp.test/authorize");
            expect(url.searchParams.get("client_id")).toBe("test-client");
            expect(url.searchParams.get("redirect_uri")).toBe(
                "https://repo.test/api/auth/callback/oidc",
            );
            expect(url.searchParams.get("code_challenge_method")).toBe("S256");
            expect(url.searchParams.get("code_challenge")).toBeTruthy();
        } finally {
            discovery.mockRestore();
        }
    });
    it("challenges Maven downloads without opening Basic auth dialogs for console APIs", async () => {
        const download = await request(
            "/maven/test/releases/com/acme/demo/1.0/demo-1.0.pom",
            "GET",
            undefined,
            "",
        );
        expect(download.status).toBe(401);
        expect(download.headers.get("www-authenticate")).toBe('Basic realm="Maven R2"');
        const files = await request(
            "/api/accounts/test/repositories/releases/files",
            "GET",
            undefined,
            "",
        );
        expect(files.status).toBe(401);
        expect(files.headers.has("www-authenticate")).toBe(false);
        expect(await files.json()).toMatchObject({ error: "Read access required" });
    });
    it("uses real Better Auth sessions and protects the last owner", async () => {
        const browser = await browserUser();
        expect(await json(await browser("/api/me"))).toMatchObject({
            user: { id: "owner", admin: true },
        });
        expect((await browser("/api/accounts/test/members/owner", "DELETE")).status).toBe(409);
        expect((await request("/api/accounts/test/tokens")).status).toBe(401);
        const created = await json<{ secret: string; token: { id: string } }>(
            await browser("/api/accounts/test/tokens", "POST", {
                name: "Read one namespace",
                scopes: [{ repository: "releases", prefixes: ["com/acme"], actions: ["read"] }],
                expiresAt: Date.now() + 60000,
            }),
            201,
        );
        expect(
            (
                await request(
                    "/api/publications",
                    "POST",
                    { account: "test", repository: "releases" },
                    created.secret,
                )
            ).status,
        ).toBe(403);
        await json(await browser("/api/accounts/test/tokens/" + created.token.id, "DELETE"));
        expect(
            (await request("/api/accounts/test/repositories", "GET", undefined, created.secret))
                .status,
        ).toBe(401);
    });
    it("restricts invitations to the intended verified identity and disallows closed signups", async () => {
        const owner = await browserUser(),
            guest = await browserUser("guest", "guest@example.com", false);
        const invitation = await json<{ url: string }>(
            await owner("/api/accounts/test/invitations", "POST", {
                email: "guest@example.com",
                role: "publisher",
            }),
            201,
        );
        const secret = invitation.url.split("/").at(-1);
        expect((await owner("/api/invitations/accept", "POST", { secret })).status).toBe(404);
        await json(await guest("/api/invitations/accept", "POST", { secret }));
        expect(await json(await guest("/api/accounts"))).toMatchObject([{ role: "publisher" }]);
        expect(
            (
                await guest("/api/accounts/test/tokens", "POST", {
                    name: "Escalate",
                    scopes: [{ repository: "releases", prefixes: [""], actions: ["delete"] }],
                    expiresAt: null,
                })
            ).status,
        ).toBe(403);
        const context = await auth(env).$context;
        await expect(
            context.internalAdapter.createUser(
                {
                    name: "Blocked",
                    email: "blocked@example.com",
                    emailVerified: true,
                },
                { method: "oauth" },
            ),
        ).rejects.toThrow("Signups are disabled");
    });
    it("deletes complete versions, updates metadata and protects readers from mutation", async () => {
        const browser = await browserUser();
        for (const version of ["1.0", "2.0"]) {
            const session = await release(version);
            await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        }
        const path = "/api/accounts/test/repositories/releases/delete-version";
        expect((await request(path, "POST", { path: "com/acme/demo/1.0" })).status).toBe(403);
        await json(await browser(path, "POST", { path: "com/acme/demo/1.0" }));
        expect((await request("/maven/test/releases/com/acme/demo/1.0/demo-1.0.jar")).status).toBe(
            404,
        );
        const metadata = parseMetadata(
            await (await request("/maven/test/releases/com/acme/demo/maven-metadata.xml")).text(),
        );
        expect(metadata.versioning?.versions?.version).toEqual(["2.0"]);
        const account = await env.DB.prepare(
            "SELECT used_bytes,reserved_bytes,(SELECT sum(size) FROM files) total FROM accounts",
        ).first();
        expect(account?.used_bytes).toBe(account?.total);
        const session = await release("3.0");
        await json(
            await browser(
                `/api/accounts/test/repositories/releases/publications/${session.id}/abort`,
                "POST",
            ),
        );
        expect((await request(`/api/publications/${session.id}/commit`, "POST")).status).toBe(409);
    });
    it("filters private file listings before pagination and invalidates expired tokens", async () => {
        const session = await release();
        await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        await env.DB.prepare("UPDATE tokens SET scopes=?")
            .bind(
                JSON.stringify([
                    { repository: "releases", prefixes: ["com/elsewhere"], actions: ["read"] },
                ]),
            )
            .run();
        expect(await json(await request("/api/accounts/test/repositories/releases/files"))).toEqual(
            { files: [], next: null },
        );
        await env.DB.prepare("UPDATE tokens SET expires_at=0").run();
        expect((await request("/api/accounts/test/repositories")).status).toBe(401);
    });
    it("expires abandoned publications and collects only unreferenced objects", async () => {
        const committed = await release("1.0"),
            abandoned = await release("2.0");
        await json(await request(`/api/publications/${committed.id}/commit`, "POST"));
        await env.DB.prepare("UPDATE publications SET expires_at=0 WHERE id=?")
            .bind(abandoned.id)
            .run();
        await cleanup(env);
        expect((await request(`/api/publications/${abandoned.id}/commit`, "POST")).status).toBe(
            409,
        );
        await env.DB.prepare("UPDATE garbage SET not_before=0").run();
        await cleanup(env);
        expect(
            await (await request("/maven/test/releases/com/acme/demo/1.0/demo-1.0.jar")).text(),
        ).toBe("artifact");
        expect(await env.DB.prepare("SELECT reserved_bytes FROM accounts").first()).toMatchObject({
            reserved_bytes: 0,
        });
    });
});

describe("workspace policies", () => {
    it("creates isolated workspaces in multi-account mode", async () => {
        const runtime = { ...env, INSTANCE_MODE: "multi" as const, ALLOW_ACCOUNT_CREATION: "true" };
        const browser = await browserUser("tenant", "tenant@example.com", false, runtime);
        expect(
            await json(
                await browser("/api/accounts", "POST", {
                    slug: "second",
                    name: "Second workspace",
                }),
                201,
            ),
        ).toMatchObject({ slug: "second", role: "owner" });
        await json(
            await browser("/api/accounts/second/repositories", "POST", {
                slug: "releases",
                name: "Releases",
                policy: "releases",
                visibility: "private",
                maxFileBytes: 1000000,
                retentionDays: 0,
            }),
            201,
        );
        expect((await browser("/api/accounts/test/members")).status).toBe(403);
        expect(
            (await request("/maven/second/releases/com/acme/demo/1.0/demo-1.0.jar")).status,
        ).toBe(403);
    });
    it("rejects quota reservations atomically", async () => {
        await env.DB.prepare("UPDATE accounts SET max_bytes=10").run();
        const session = await begin();
        expect(
            (
                await request(`/api/publications/${session.id}/uploads`, "POST", {
                    path: "com/acme/demo/1.0/demo-1.0.pom",
                    size: 11,
                    sha256: await hash("x".repeat(11)),
                })
            ).status,
        ).toBe(413);
        expect(await env.DB.prepare("SELECT reserved_bytes FROM accounts").first()).toMatchObject({
            reserved_bytes: 0,
        });
        expect(await env.DB.prepare("SELECT count(*) count FROM uploads").first()).toMatchObject({
            count: 0,
        });
    });
    it("prunes superseded snapshots while preserving current metadata targets", async () => {
        for (const build of [1, 2]) {
            const session = await begin("snapshots");
            const root = `com/acme/demo/1.0-SNAPSHOT/demo-1.0-20260920.120000-${build}`;
            await stage(session.id, root + ".pom", pom("1.0-SNAPSHOT"));
            await stage(session.id, root + ".jar", `snapshot-${build}`);
            await json(await request(`/api/publications/${session.id}/commit`, "POST"));
        }
        await env.DB.prepare(
            "UPDATE files SET updated_at=0 WHERE path LIKE '%-1.jar' OR path LIKE '%-1.pom'",
        ).run();
        await cleanup(env);
        expect(
            (
                await request(
                    "/maven/test/snapshots/com/acme/demo/1.0-SNAPSHOT/demo-1.0-20260920.120000-1.jar",
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await request(
                    "/maven/test/snapshots/com/acme/demo/1.0-SNAPSHOT/demo-1.0-20260920.120000-2.jar",
                )
            ).status,
        ).toBe(200);
    });
});
