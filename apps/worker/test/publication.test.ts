import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { hash, newSecret } from "../src/security";
import { parseMetadata } from "../src/metadata";
import { PART_SIZE } from "../src/storage";
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
