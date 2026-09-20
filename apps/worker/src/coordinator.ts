import { DurableObject } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { initUploadRoute } from "@maven-r2/contracts";
import type { Env } from "./env";
import {
    audit,
    publicationView,
    type FileRow,
    type PublicationRow,
    type RepositoryRow,
    type UploadRow,
} from "./db";
import { authenticate, fail, type Principal } from "./security";
import { authorizeUpload, initiateUpload, sessionAccess } from "./publications";
import {
    artifactMetadata,
    checksumBase,
    coordinates,
    isMetadata,
    mergePlugins,
    parseMetadata,
    snapshotMetadata,
    validatePom,
    xmlMetadata,
    type Metadata,
} from "./metadata";
import { readSmall, storeText, type Checksums } from "./storage";

export class RepositoryCoordinator extends DurableObject<Env> {
    private pending: Promise<unknown> = Promise.resolve();

    fetch(request: Request): Promise<Response> {
        const result = this.pending
            .then(() => this.handle(request))
            .catch((error) => {
                if (error instanceof HTTPException)
                    return Response.json({ error: error.message }, { status: error.status });
                if (String(error).includes("CHECK constraint"))
                    return Response.json(
                        { error: "Account storage quota exceeded" },
                        { status: 413 },
                    );
                console.error(
                    "Repository operation failed",
                    error instanceof Error ? error.message : "Unknown error",
                );
                return Response.json(
                    { error: "Repository operation failed. Retry the request." },
                    { status: 500 },
                );
            });
        this.pending = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async handle(request: Request) {
        const [operation, id] = new URL(request.url).pathname.split("/").slice(1);
        if (operation === "expire") {
            await this.expire(id!);
            return Response.json({ ok: true });
        }
        const principal = await authenticate(request, this.env);
        if (!principal) fail(401, "Authentication required");
        if (operation === "uploads") {
            const input = initUploadRoute.request.body.content["application/json"].schema.parse(
                await request.json(),
            );
            return Response.json(await initiateUpload(this.env, principal, id!, input));
        }
        const { session, repo } = await sessionAccess(this.env, principal, id!);
        if (operation === "abort")
            return Response.json(publicationView(await this.abort(session, repo)));
        if (operation === "commit")
            return Response.json(publicationView(await this.commit(principal, session, repo)));
        fail(404, "Unknown operation");
    }

    private async abort(session: PublicationRow, repo: RepositoryRow): Promise<PublicationRow> {
        if (session.status === "committed") fail(409, "Committed publications cannot be aborted");
        if (session.status === "aborted") return session;
        const uploads = (
            await this.env.DB.prepare("SELECT * FROM uploads WHERE publication_id=?")
                .bind(session.id)
                .all<UploadRow>()
        ).results;
        await this.env.DB.batch([
            this.env.DB.prepare(
                "UPDATE accounts SET reserved_bytes=reserved_bytes-? WHERE id=?",
            ).bind(
                uploads.reduce((sum, item) => sum + item.size, 0),
                repo.account_id,
            ),
            ...uploads.map((upload) =>
                this.env.DB.prepare(
                    "INSERT OR REPLACE INTO garbage (object_key,multipart_id,not_before) VALUES (?,?,?)",
                ).bind(upload.object_key, upload.multipart_id, Date.now() + 60_000),
            ),
            this.env.DB.prepare("UPDATE publications SET status='aborted' WHERE id=?").bind(
                session.id,
            ),
            audit(this.env, repo.account_id, session.actor, "publication.aborted", session.id),
        ]);
        return { ...session, status: "aborted" };
    }

    private async commit(
        principal: Principal,
        session: PublicationRow,
        repo: RepositoryRow,
    ): Promise<PublicationRow> {
        if (session.status === "committed") return session;
        if (session.status !== "open" || session.expires_at <= Date.now())
            fail(409, "Publication is closed or expired");
        const uploads = (
            await this.env.DB.prepare("SELECT * FROM uploads WHERE publication_id=? ORDER BY path")
                .bind(session.id)
                .all<UploadRow>()
        ).results;
        if (!uploads.length || uploads.some((upload) => upload.status !== "complete"))
            fail(409, "All files must finish uploading before publication");
        for (const upload of uploads)
            await authorizeUpload(this.env, principal, repo, session.id, upload.path);
        const now = Date.now();
        const originals = new Map<string, FileRow>();
        const artifacts = new Set<string>(),
            snapshots = new Set<string>();
        for (const upload of uploads) {
            const c = coordinates(upload.path);
            if (c) {
                artifacts.add(c.artifactPath);
                if (c.snapshot) snapshots.add(c.versionPath);
            }
        }
        if (!artifacts.size) fail(400, "A publication must include an artifact");
        for (const artifact of artifacts) {
            const prefix = artifact + "/";
            const rows = await this.env.DB.prepare(
                "SELECT * FROM files WHERE repository_id=? AND path>=? AND path<?",
            )
                .bind(repo.id, prefix, prefix + "\uffff")
                .all<FileRow>();
            for (const row of rows.results) originals.set(row.path, row);
        }
        const current = new Map(originals),
            changed = new Map<string, FileRow>();
        for (const upload of uploads) {
            if (checksumBase(upload.path) || isMetadata(upload.path)) continue;
            const base = upload.path.endsWith(".asc") ? upload.path.slice(0, -4) : upload.path;
            if (isMetadata(base))
                fail(400, "Signatures on mutable repository metadata are unsupported");
            const c = coordinates(base)!;
            const old = originals.get(upload.path);
            if (!c.snapshot && old && old.sha256 !== upload.sha256)
                fail(409, "Release artifacts are immutable");
            if (
                !c.snapshot &&
                !old &&
                [...originals.keys()].some((path) => path.startsWith(c.versionPath + "/"))
            )
                fail(409, "This release version is already published");
            if (upload.path.endsWith(".pom"))
                validatePom(await readSmall(this.env, upload.object_key), upload.path);
            if (old?.sha256 === upload.sha256) continue;
            const file: FileRow = {
                repository_id: repo.id,
                path: upload.path,
                object_key: upload.object_key,
                size: upload.size,
                sha256: upload.sha256,
                checksums: upload.checksums!,
                publication_id: session.id,
                updated_at: now,
            };
            current.set(file.path, file);
            changed.set(file.path, file);
        }
        for (const upload of uploads) {
            const c = coordinates(upload.path);
            if (
                c &&
                ![...current.keys()].some(
                    (path) => path.startsWith(c.versionPath + "/") && path.endsWith(".pom"),
                )
            )
                fail(400, "Each published version must include a POM");
            const checksum = checksumBase(upload.path);
            if (checksum) {
                const base =
                    uploads.find((item) => item.path === checksum.path) ??
                    current.get(checksum.path);
                if (!base?.checksums) fail(400, "Checksum has no corresponding artifact");
                const supplied = (await readSmall(this.env, upload.object_key))
                    .trim()
                    .split(/\s+/)[0]
                    ?.toLowerCase();
                if (supplied !== (JSON.parse(base.checksums) as Checksums)[checksum.algorithm])
                    fail(400, "Uploaded checksum does not match the artifact");
            }
        }
        const metadataPaths = new Set(
            [...artifacts, ...snapshots].map((path) => path + "/maven-metadata.xml"),
        );
        for (const upload of uploads) if (isMetadata(upload.path)) metadataPaths.add(upload.path);
        for (const path of metadataPaths) {
            const old =
                originals.get(path) ??
                (await this.env.DB.prepare("SELECT * FROM files WHERE repository_id=? AND path=?")
                    .bind(repo.id, path)
                    .first<FileRow>());
            if (old) originals.set(path, old);
            const oldText = old ? await readSmall(this.env, old.object_key) : undefined;
            let result: Metadata = oldText ? parseMetadata(oldText) : {};
            const incoming = uploads.find((upload) => upload.path === path);
            if (incoming)
                result = mergePlugins(
                    path,
                    parseMetadata(await readSmall(this.env, incoming.object_key)),
                    result,
                    uploads,
                );
            const parent = path.slice(0, -"/maven-metadata.xml".length);
            if (artifacts.has(parent))
                result = artifactMetadata(path, [...current.values()], result);
            if (snapshots.has(parent)) result = snapshotMetadata(path, [...current.values()]);
            if (!result.versioning && !result.plugins) continue;
            const text = xmlMetadata(result);
            if (text === oldText) continue;
            const stored = await storeText(this.env, repo.account_id, text);
            changed.set(path, {
                ...stored,
                repository_id: repo.id,
                path,
                publication_id: session.id,
                updated_at: now,
            });
        }
        const reserved = uploads.reduce((sum, item) => sum + item.size, 0);
        const delta = [...changed.values()].reduce(
            (sum, item) => sum + item.size - (originals.get(item.path)?.size ?? 0),
            0,
        );
        const statements: D1PreparedStatement[] = [
            this.env.DB.prepare(
                "UPDATE accounts SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+? WHERE id=?",
            ).bind(reserved, delta, repo.account_id),
        ];
        for (const file of changed.values()) {
            statements.push(
                this.env.DB.prepare(
                    "INSERT INTO files (repository_id,path,object_key,size,sha256,checksums,publication_id,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,path) DO UPDATE SET object_key=excluded.object_key,size=excluded.size,sha256=excluded.sha256,checksums=excluded.checksums,publication_id=excluded.publication_id,updated_at=excluded.updated_at",
                ).bind(
                    repo.id,
                    file.path,
                    file.object_key,
                    file.size,
                    file.sha256,
                    file.checksums,
                    session.id,
                    file.updated_at,
                ),
            );
            const old = originals.get(file.path);
            if (old)
                statements.push(
                    this.env.DB.prepare(
                        "INSERT OR IGNORE INTO garbage (object_key,not_before) VALUES (?,?)",
                    ).bind(old.object_key, now + 60 * 60 * 1000),
                );
        }
        const retained = new Set([...changed.values()].map((file) => file.object_key));
        for (const upload of uploads)
            if (!retained.has(upload.object_key))
                statements.push(
                    this.env.DB.prepare(
                        "INSERT OR IGNORE INTO garbage (object_key,not_before) VALUES (?,?)",
                    ).bind(upload.object_key, now + 60 * 60 * 1000),
                );
        statements.push(
            this.env.DB.prepare(
                "UPDATE publications SET status='committed',committed_at=? WHERE id=?",
            ).bind(now, session.id),
            audit(this.env, repo.account_id, principal.actor, "publication.committed", session.id),
        );
        await this.env.DB.batch(statements);
        return { ...session, status: "committed", committed_at: now };
    }

    private async expire(repoId: string) {
        const repo = await this.env.DB.prepare("SELECT * FROM repositories WHERE id=?")
            .bind(repoId)
            .first<RepositoryRow>();
        if (!repo) return;
        const expired = await this.env.DB.prepare(
            "SELECT * FROM publications WHERE repository_id=? AND status='open' AND expires_at<=? LIMIT 20",
        )
            .bind(repoId, Date.now())
            .all<PublicationRow>();
        for (const session of expired.results) await this.abort(session, repo);
        if (repo.retention_days <= 0) return;
        const cutoff = Date.now() - repo.retention_days * 24 * 60 * 60 * 1000;
        const candidates = await this.env.DB.prepare(
            "SELECT * FROM files WHERE repository_id=? AND updated_at<? AND path LIKE '%-SNAPSHOT/%' AND path NOT LIKE '%maven-metadata.xml' LIMIT 500",
        )
            .bind(repoId, cutoff)
            .all<FileRow>();
        const removable: FileRow[] = [];
        for (const file of candidates.results) {
            const c = coordinates(file.path.endsWith(".asc") ? file.path.slice(0, -4) : file.path);
            if (!c) continue;
            const meta = await this.env.DB.prepare(
                "SELECT * FROM files WHERE repository_id=? AND path=?",
            )
                .bind(repoId, c.versionPath + "/maven-metadata.xml")
                .first<FileRow>();
            if (!meta) continue;
            const values =
                parseMetadata(
                    await readSmall(this.env, meta.object_key),
                ).versioning?.snapshotVersions?.snapshotVersion.map((item) => item.value) ?? [];
            if (!values.includes(c.value)) removable.push(file);
        }
        if (removable.length)
            await this.env.DB.batch([
                ...removable.flatMap((file) => [
                    this.env.DB.prepare("DELETE FROM files WHERE repository_id=? AND path=?").bind(
                        repoId,
                        file.path,
                    ),
                    this.env.DB.prepare(
                        "INSERT OR IGNORE INTO garbage (object_key,not_before) VALUES (?,?)",
                    ).bind(file.object_key, Date.now() + 60 * 60 * 1000),
                ]),
                this.env.DB.prepare("UPDATE accounts SET used_bytes=used_bytes-? WHERE id=?").bind(
                    removable.reduce((sum, file) => sum + file.size, 0),
                    repo.account_id,
                ),
                audit(this.env, repo.account_id, "system", "snapshots.pruned", repo.id),
            ]);
    }
}
