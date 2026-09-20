import type { OpenAPIHono } from "@hono/zod-openapi";
import {
    abortSessionRoute,
    commitSessionRoute,
    completeUploadRoute,
    createSessionRoute,
    getSessionRoute,
    initUploadRoute,
    publicationSchema,
    uploadSchema,
    errorSchema,
} from "@maven-r2/contracts";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { AppEnv, Env } from "./env";
import {
    audit,
    publicationView,
    type PublicationRow,
    type RepositoryRow,
    type UploadRow,
} from "./db";
import {
    accountRole,
    canonicalPath,
    fail,
    getRepository,
    requireAccess,
    roleAllows,
    tokenAllows,
    type Principal,
} from "./security";
import { checksumBase, coordinates, isMetadata, publicationAction } from "./metadata";
import { PART_SIZE, MAX_METADATA_SIZE, digestStream } from "./storage";
import { serveFile } from "./downloads";

export async function sessionAccess(
    env: Env,
    principal: Principal | null,
    id: string,
    open = false,
) {
    const session = await env.DB.prepare("SELECT * FROM publications WHERE id=?")
        .bind(id)
        .first<PublicationRow>();
    if (
        !session ||
        !principal ||
        session.actor !== principal.actor ||
        (principal.token && principal.token.id !== session.token_id)
    )
        fail(404, "Publication not found");
    const repo = await env.DB.prepare(
        "SELECT r.* FROM repositories r JOIN accounts a ON a.id=r.account_id WHERE r.id=? AND a.suspended=0",
    )
        .bind(session.repository_id)
        .first<RepositoryRow>();
    if (!repo || !roleAllows(await accountRole(env, principal, repo.account_id), "publish:release"))
        fail(403, "Publishing permission removed");
    if (open && (session.status !== "open" || session.expires_at <= Date.now()))
        fail(409, "Publication is closed or expired");
    return { session, repo };
}
export async function authorizeUpload(
    env: Env,
    principal: Principal,
    repo: RepositoryRow,
    session: string,
    path: string,
    staged?: UploadRow[],
) {
    const action = publicationAction(path);
    if (action) {
        if (
            (repo.policy === "releases" && action === "publish:snapshot") ||
            (repo.policy === "snapshots" && action === "publish:release")
        )
            fail(400, "Artifact does not match the repository policy");
        await requireAccess(env, principal, repo, action, path);
        return;
    }
    const metadataPath = checksumBase(path)?.path ?? path;
    const uploads =
        staged ??
        (
            await env.DB.prepare("SELECT * FROM uploads WHERE publication_id=?")
                .bind(session)
                .all<UploadRow>()
        ).results;
    for (const upload of uploads) {
        const coordinate = coordinates(upload.path);
        if (!coordinate) continue;
        if (
            [
                coordinate.groupPath,
                coordinate.artifactPath,
                coordinate.snapshot ? coordinate.versionPath : "",
            ].some((parent) => parent + "/maven-metadata.xml" === metadataPath)
        ) {
            await requireAccess(
                env,
                principal,
                repo,
                coordinate.snapshot ? "publish:snapshot" : "publish:release",
                upload.path,
            );
            return;
        }
    }
    fail(403, "Metadata must accompany an authorized artifact publication");
}
export async function uploadView(env: Env, upload: UploadRow) {
    const parts = await env.DB.prepare(
        "SELECT number,etag FROM upload_parts WHERE upload_id=? ORDER BY number",
    )
        .bind(upload.id)
        .all<{ number: number; etag: string }>();
    return {
        id: upload.id,
        path: upload.path,
        size: upload.size,
        sha256: upload.sha256,
        status: upload.status,
        partSize: PART_SIZE,
        parts: parts.results,
    };
}
export async function coordinatorRequest(env: Env, repoId: string, path: string, request: Request) {
    const stub = env.REPOSITORIES.get(env.REPOSITORIES.idFromName(repoId));
    return stub.fetch(
        new Request("https://repository" + path, {
            method: request.method,
            headers: request.headers,
            body: request.body,
        }),
    );
}
async function coordinatorJson<T extends z.ZodType>(
    response: Response,
    schema: T,
): Promise<z.output<T>> {
    const body: unknown = await response.json();
    if (!response.ok)
        throw new HTTPException(response.status as ContentfulStatusCode, {
            message: errorSchema.parse(body).error,
        });
    return schema.parse(body);
}

export function registerPublications(app: OpenAPIHono<AppEnv>) {
    app.openapi(createSessionRoute, async (c) => {
        const principal = c.get("principal");
        if (!principal) fail(401, "A publishing token is required");
        const input = c.req.valid("json");
        const { account, repository: repo } = await getRepository(
            c.env,
            input.account,
            input.repository,
        );
        const role = await accountRole(c.env, principal, account.id);
        if (!roleAllows(role, "publish:release")) fail(403, "Publishing permission required");
        if (principal.token) {
            const allowed = (
                JSON.parse(principal.token.scopes) as import("@maven-r2/contracts").Scope[]
            ).some(
                (scope) =>
                    scope.repository === repo.slug &&
                    scope.actions.some((action) => action.startsWith("publish:")),
            );
            if (principal.token.account_id !== account.id || !allowed)
                fail(403, "Token cannot publish to this repository");
        }
        const now = Date.now(),
            id = crypto.randomUUID();
        await c.env.DB.batch([
            c.env.DB.prepare(
                "INSERT INTO publications (id,repository_id,actor,token_id,status,label,created_at,expires_at) VALUES (?,?,?,?,'open',?,?,?)",
            ).bind(
                id,
                repo.id,
                principal.actor,
                principal.token?.id ?? null,
                input.label,
                now,
                now + 24 * 60 * 60 * 1000,
            ),
            audit(c.env, account.id, principal.actor, "publication.created", id),
        ]);
        return c.json(publicationView((await sessionAccess(c.env, principal, id)).session), 201);
    });
    app.openapi(getSessionRoute, async (c) =>
        c.json(
            publicationView(
                (await sessionAccess(c.env, c.get("principal"), c.req.valid("param").session))
                    .session,
            ),
            200,
        ),
    );
    app.openapi(initUploadRoute, async (c) => {
        const id = c.req.valid("param").session;
        const { repo } = await sessionAccess(c.env, c.get("principal"), id, true);
        const response = await coordinatorRequest(
            c.env,
            repo.id,
            `/uploads/${id}`,
            new Request(c.req.url, {
                method: "POST",
                headers: c.req.raw.headers,
                body: JSON.stringify(c.req.valid("json")),
            }),
        );
        return c.json(await coordinatorJson(response, uploadSchema), 200);
    });
    app.openapi(completeUploadRoute, async (c) => {
        const { session: id, upload: uploadId } = c.req.valid("param");
        await sessionAccess(c.env, c.get("principal"), id, true);
        const upload = await c.env.DB.prepare(
            "SELECT * FROM uploads WHERE id=? AND publication_id=?",
        )
            .bind(uploadId, id)
            .first<UploadRow>();
        if (!upload) fail(404, "Upload not found");
        if (upload.status === "complete") return c.json(await uploadView(c.env, upload), 200);
        if (upload.multipart_id) {
            const parts = await c.env.DB.prepare(
                "SELECT number,etag,size FROM upload_parts WHERE upload_id=? ORDER BY number",
            )
                .bind(upload.id)
                .all<{ number: number; etag: string; size: number }>();
            const expected = Math.ceil(upload.size / PART_SIZE);
            if (
                parts.results.length !== expected ||
                parts.results.some(
                    (part, index) =>
                        part.number !== index + 1 ||
                        part.size !== Math.min(PART_SIZE, upload.size - index * PART_SIZE),
                )
            )
                fail(409, "Upload has missing parts");
            if (!(await c.env.BUCKET.head(upload.object_key))) {
                await c.env.BUCKET.resumeMultipartUpload(
                    upload.object_key,
                    upload.multipart_id,
                ).complete(
                    parts.results.map((part) => ({ partNumber: part.number, etag: part.etag })),
                );
            }
        }
        const object = await c.env.BUCKET.get(upload.object_key);
        if (!object) fail(409, "Upload has missing parts");
        const { checksums } = await digestStream(object.body, upload.size);
        if (checksums.sha256 !== upload.sha256) fail(400, "Artifact checksum mismatch");
        await c.env.DB.prepare("UPDATE uploads SET status='complete',checksums=? WHERE id=?")
            .bind(JSON.stringify(checksums), upload.id)
            .run();
        return c.json(await uploadView(c.env, { ...upload, status: "complete" }), 200);
    });
    app.openapi(commitSessionRoute, async (c) => {
        const id = c.req.valid("param").session;
        const { repo } = await sessionAccess(c.env, c.get("principal"), id);
        return c.json(
            await coordinatorJson(
                await coordinatorRequest(c.env, repo.id, `/commit/${id}`, c.req.raw),
                publicationSchema,
            ),
            200,
        );
    });
    app.openapi(abortSessionRoute, async (c) => {
        const id = c.req.valid("param").session;
        const { repo } = await sessionAccess(c.env, c.get("principal"), id);
        return c.json(
            await coordinatorJson(
                await coordinatorRequest(
                    c.env,
                    repo.id,
                    `/abort/${id}`,
                    new Request(c.req.url, { method: "POST", headers: c.req.raw.headers }),
                ),
                publicationSchema,
            ),
            200,
        );
    });
    app.put("/api/publications/:session/uploads/:upload/parts/:part", async (c) => {
        const { repo } = await sessionAccess(
            c.env,
            c.get("principal"),
            c.req.param("session"),
            true,
        );
        const upload = await c.env.DB.prepare(
            "SELECT * FROM uploads WHERE id=? AND publication_id=?",
        )
            .bind(c.req.param("upload"), c.req.param("session"))
            .first<UploadRow>();
        if (!upload) fail(404, "Upload not found");
        await authorizeUpload(c.env, c.get("principal")!, repo, upload.publication_id, upload.path);
        if (upload.status === "complete") return c.json({ complete: true });
        const part = Number(c.req.param("part"));
        const total = Math.max(1, Math.ceil(upload.size / PART_SIZE));
        if (!Number.isInteger(part) || part < 1 || part > total) fail(400, "Invalid part number");
        const length = Math.min(PART_SIZE, upload.size - (part - 1) * PART_SIZE);
        if (c.req.header("content-length") !== String(length))
            fail(400, "Part Content-Length must match the declared size");
        const stream = c.req.raw.body ?? new Blob([]).stream();
        let etag: string;
        if (upload.multipart_id) {
            const result = await c.env.BUCKET.resumeMultipartUpload(
                upload.object_key,
                upload.multipart_id,
            ).uploadPart(part, stream);
            etag = result.etag;
        } else {
            let result: R2Object | null;
            try {
                result = await c.env.BUCKET.put(upload.object_key, stream, {
                    onlyIf: { etagDoesNotMatch: "*" },
                    sha256: upload.sha256,
                });
            } catch (error) {
                if (/checksum|sha-?256/i.test(String(error)))
                    fail(400, "Artifact checksum mismatch");
                throw error;
            }
            etag = result?.etag ?? (await c.env.BUCKET.head(upload.object_key))!.etag;
        }
        await c.env.DB.prepare(
            "INSERT INTO upload_parts (upload_id,number,etag,size) VALUES (?,?,?,?) ON CONFLICT(upload_id,number) DO UPDATE SET etag=excluded.etag,size=excluded.size",
        )
            .bind(upload.id, part, etag, length)
            .run();
        return c.json({ number: part, etag });
    });
    app.on(["GET", "HEAD"], "/api/publications/:session/files", async (c) => {
        const { session, repo } = await sessionAccess(
            c.env,
            c.get("principal"),
            c.req.param("session"),
            true,
        );
        const path = canonicalPath(c.req.query("path") ?? "");
        const upload = await c.env.DB.prepare(
            "SELECT * FROM uploads WHERE publication_id=? AND path=? AND status='complete'",
        )
            .bind(session.id, path)
            .first<UploadRow>();
        if (upload)
            return serveFile(c.req.raw, c.env, {
                repository_id: repo.id,
                path,
                object_key: upload.object_key,
                size: upload.size,
                sha256: upload.sha256,
                checksums: upload.checksums!,
                publication_id: session.id,
                updated_at: session.created_at,
            });
        if (
            c.get("principal")?.token &&
            !tokenAllows(c.get("principal")!.token!, repo, "read", path) &&
            repo.visibility !== "public"
        )
            return c.body(null, 404);
        await requireAccess(c.env, c.get("principal"), repo, "read", path);
        const file = await c.env.DB.prepare("SELECT * FROM files WHERE repository_id=? AND path=?")
            .bind(repo.id, path)
            .first<import("./db").FileRow>();
        return file ? serveFile(c.req.raw, c.env, file) : c.body(null, 404);
    });
}

export async function initiateUpload(
    env: Env,
    principal: Principal,
    sessionId: string,
    input: { path: string; size: number; sha256: string },
) {
    const { session, repo } = await sessionAccess(env, principal, sessionId, true);
    const path = canonicalPath(input.path);
    await authorizeUpload(env, principal, repo, session.id, path);
    if (input.size > repo.max_file_bytes || input.size > Number(env.MAX_FILE_BYTES))
        fail(413, "Artifact exceeds the repository file limit");
    if (
        (isMetadata(checksumBase(path)?.path ?? path) ||
            path.endsWith(".pom") ||
            checksumBase(path)) &&
        input.size > MAX_METADATA_SIZE
    )
        fail(413, "Metadata exceeds the size limit");
    const existing = await env.DB.prepare("SELECT * FROM uploads WHERE publication_id=? AND path=?")
        .bind(session.id, path)
        .first<UploadRow>();
    if (existing) {
        if (existing.sha256 !== input.sha256 || existing.size !== input.size)
            fail(409, "This path already has different content in the publication");
        if (existing.status === "pending" && existing.size > PART_SIZE && !existing.multipart_id) {
            const multipart = await env.BUCKET.createMultipartUpload(existing.object_key);
            existing.multipart_id = multipart.uploadId;
            await env.DB.prepare("UPDATE uploads SET multipart_id=? WHERE id=?")
                .bind(multipart.uploadId, existing.id)
                .run();
        }
        return uploadView(env, existing);
    }
    const count = await env.DB.prepare(
        "SELECT count(*) AS count FROM uploads WHERE publication_id=?",
    )
        .bind(session.id)
        .first<{ count: number }>();
    if (count!.count >= 500) fail(413, "A publication may contain at most 500 uploaded files");
    const id = crypto.randomUUID(),
        key = `objects/${repo.account_id}/${id}`;
    const upload: UploadRow = {
        id,
        publication_id: session.id,
        path,
        object_key: key,
        size: input.size,
        sha256: input.sha256,
        status: "pending",
        multipart_id: null,
        checksums: null,
    };
    try {
        await env.DB.batch([
            env.DB.prepare("UPDATE accounts SET reserved_bytes=reserved_bytes+? WHERE id=?").bind(
                input.size,
                repo.account_id,
            ),
            env.DB.prepare(
                "INSERT INTO uploads (id,publication_id,path,object_key,size,sha256,status) VALUES (?,?,?,?,?,?,'pending')",
            ).bind(id, session.id, path, key, input.size, input.sha256),
        ]);
    } catch (error) {
        if (String(error).includes("CHECK constraint")) fail(413, "Account storage quota exceeded");
        throw error;
    }
    if (input.size > PART_SIZE) {
        const multipart = await env.BUCKET.createMultipartUpload(key);
        upload.multipart_id = multipart.uploadId;
        await env.DB.prepare("UPDATE uploads SET multipart_id=? WHERE id=?")
            .bind(multipart.uploadId, id)
            .run();
    }
    return uploadView(env, upload);
}
