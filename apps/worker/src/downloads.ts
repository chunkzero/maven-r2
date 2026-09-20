import type { Env, AppEnv } from "./env";
import type { FileRow } from "./db";
import { contentType } from "./db";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { canonicalPath, fail, getRepository, requireAccess } from "./security";
import { checksumBase } from "./metadata";
import type { Checksums } from "./storage";

export async function serveFile(
    request: Request,
    env: Env,
    file: FileRow,
    checksum?: keyof Checksums,
) {
    const digest = checksum ? (JSON.parse(file.checksums) as Checksums)[checksum] : undefined;
    const etag = `"${file.sha256}${checksum ? "-" + checksum : ""}"`;
    const headers = new Headers({
        etag: etag,
        "last-modified": new Date(file.updated_at).toUTCString(),
        "content-type": checksum ? "text/plain; charset=utf-8" : contentType(file.path),
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
    });
    if (
        request.headers
            .get("if-none-match")
            ?.split(/\s*,\s*/)
            .some((value) => value === etag || value === "*")
    )
        return new Response(null, { status: 304, headers });
    if (
        !request.headers.has("if-none-match") &&
        request.headers.has("if-modified-since") &&
        Math.floor(file.updated_at / 1000) * 1000 <=
            Date.parse(request.headers.get("if-modified-since")!)
    )
        return new Response(null, { status: 304, headers });
    const size = digest ? digest.length : file.size;
    let range: { offset: number; length: number } | undefined;
    const requestedRange = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    if (
        requestedRange &&
        (!ifRange ||
            ifRange === etag ||
            Date.parse(ifRange) >= Math.floor(file.updated_at / 1000) * 1000)
    ) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
        if (!match || (!match[1] && !match[2]) || size === 0)
            return new Response(null, {
                status: 416,
                headers: { "content-range": `bytes */${size}` },
            });
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[1]
            ? match[2]
                ? Math.min(size - 1, Number(match[2]))
                : size - 1
            : size - 1;
        if (
            start >= size ||
            start > end ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end)
        )
            return new Response(null, {
                status: 416,
                headers: { "content-range": `bytes */${size}` },
            });
        range = { offset: start, length: end - start + 1 };
        headers.set("content-range", `bytes ${start}-${end}/${size}`);
        headers.set("content-length", String(end - start + 1));
    } else headers.set("content-length", String(size));
    const status = range ? 206 : 200;
    if (request.method === "HEAD") return new Response(null, { status, headers });
    if (digest)
        return new Response(
            range ? digest.slice(range.offset, range.offset! + range.length!) : digest,
            { status, headers },
        );
    const object = await env.BUCKET.get(file.object_key, { range });
    if (!object) fail(404, "Artifact not found");
    return new Response(object.body, { status, headers });
}
export function registerDownloads(app: OpenAPIHono<AppEnv>) {
    app.on(["GET", "HEAD"], "/maven/:account/:repository/*", async (c) => {
        const raw = new URL(c.req.url).pathname.split("/").slice(4).join("/");
        let path: string;
        try {
            path = decodeURIComponent(raw);
        } catch {
            fail(400, "Invalid artifact path");
        }
        return serveRepositoryFile(c, c.req.param("account"), c.req.param("repository"), path);
    });
    app.all("*", async (c, next) => {
        const mapping = c.get("repositoryMapping");
        if (!mapping) return next();
        if (!["GET", "HEAD"].includes(c.req.method))
            return c.json({ error: "Publish through the local maven-r2 proxy" }, 405);
        if (!mapping.path) fail(404, "Artifact not found");
        return serveRepositoryFile(c, mapping.account, mapping.repository, mapping.path);
    });
}

async function serveRepositoryFile(
    c: Context<AppEnv>,
    account: string,
    slug: string,
    artifactPath: string,
) {
    const { repository } = await getRepository(c.env, account, slug);
    const path = canonicalPath(artifactPath);
    await requireAccess(c.env, c.get("principal"), repository, "read", path);
    const checksum = checksumBase(path);
    const file = await c.env.DB.prepare("SELECT * FROM files WHERE repository_id=? AND path=?")
        .bind(repository.id, checksum?.path ?? path)
        .first<FileRow>();
    if (!file) fail(404, "Artifact not found");
    return serveFile(c.req.raw, c.env, file, checksum?.algorithm);
}
