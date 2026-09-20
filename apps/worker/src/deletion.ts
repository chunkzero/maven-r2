import type { Env } from "./env";
import { audit, type FileRow, type RepositoryRow } from "./db";
import { fail, requireAccess, type Principal } from "./security";
import { artifactMetadata, parseMetadata, xmlMetadata } from "./metadata";
import { readSmall, storeText } from "./storage";

export async function deleteVersion(env: Env, principal: Principal, repoId: string, path: string) {
    if (path.split("/").length < 3) fail(400, "Specify a full group/artifact/version path");
    const repo = await env.DB.prepare(
        "SELECT r.* FROM repositories r JOIN accounts a ON a.id=r.account_id WHERE r.id=? AND a.suspended=0",
    )
        .bind(repoId)
        .first<RepositoryRow>();
    if (!repo) fail(404, "Repository not found");
    await requireAccess(env, principal, repo, "delete", path);
    const artifact = path.slice(0, path.lastIndexOf("/")),
        prefix = artifact + "/";
    const files = (
        await env.DB.prepare("SELECT * FROM files WHERE repository_id=? AND path>=? AND path<?")
            .bind(repo.id, prefix, prefix + "\uffff")
            .all<FileRow>()
    ).results;
    const removed = files.filter(
        (file) =>
            file.path.startsWith(path + "/") && !file.path.slice(path.length + 1).includes("/"),
    );
    if (!removed.length) fail(404, "Version not found");
    for (const file of removed) await requireAccess(env, principal, repo, "delete", file.path);
    const remaining = files.filter((file) => !removed.includes(file)),
        metadataPath = artifact + "/maven-metadata.xml",
        old = remaining.find((file) => file.path === metadataPath);
    const statements: D1PreparedStatement[] = [
        env.DB.prepare(
            "INSERT OR IGNORE INTO garbage (object_key,not_before) SELECT object_key,? FROM files WHERE repository_id=? AND path>=? AND path<? AND instr(substr(path,?),'/')=0",
        ).bind(Date.now() + 60 * 60 * 1000, repo.id, path + "/", path + "/\uffff", path.length + 2),
        env.DB.prepare(
            "DELETE FROM files WHERE repository_id=? AND path>=? AND path<? AND instr(substr(path,?),'/')=0",
        ).bind(repo.id, path + "/", path + "/\uffff", path.length + 2),
    ];
    let delta = -removed.reduce((sum, file) => sum + file.size, 0);
    if (old) {
        const metadata = artifactMetadata(
            metadataPath,
            remaining,
            parseMetadata(await readSmall(env, old.object_key)),
        );
        if (metadata.versioning || metadata.plugins) {
            const stored = await storeText(env, repo.account_id, xmlMetadata(metadata));
            delta += stored.size - old.size;
            statements.push(
                env.DB.prepare("DELETE FROM garbage WHERE object_key=?").bind(stored.object_key),
            );
            statements.push(
                env.DB.prepare(
                    "UPDATE files SET object_key=?,size=?,sha256=?,checksums=?,updated_at=? WHERE repository_id=? AND path=?",
                ).bind(
                    stored.object_key,
                    stored.size,
                    stored.sha256,
                    stored.checksums,
                    Date.now(),
                    repo.id,
                    metadataPath,
                ),
            );
        } else {
            delta -= old.size;
            statements.push(
                env.DB.prepare("DELETE FROM files WHERE repository_id=? AND path=?").bind(
                    repo.id,
                    metadataPath,
                ),
            );
        }
        statements.push(
            env.DB.prepare(
                "INSERT OR IGNORE INTO garbage (object_key,not_before) VALUES (?,?)",
            ).bind(old.object_key, Date.now() + 60 * 60 * 1000),
        );
    }
    statements.push(
        env.DB.prepare("UPDATE accounts SET used_bytes=used_bytes+? WHERE id=?").bind(
            delta,
            repo.account_id,
        ),
        audit(env, repo.account_id, principal.actor, "version.deleted", repo.slug + "/" + path),
    );
    await env.DB.batch(statements);
}
