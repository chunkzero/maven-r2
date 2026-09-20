import type { Env } from "./env";

export async function cleanup(env: Env) {
    const repos = await env.DB.prepare(
        "SELECT DISTINCT r.id FROM repositories r LEFT JOIN publications p ON p.repository_id=r.id AND p.status='open' AND p.expires_at<=? WHERE p.id IS NOT NULL OR r.retention_days>0 ORDER BY r.last_maintenance_at,r.id LIMIT 100",
    )
        .bind(Date.now())
        .all<{ id: string }>();
    for (const repo of repos.results) {
        const result = await env.REPOSITORIES.get(env.REPOSITORIES.idFromName(repo.id)).fetch(
            `https://repository/expire/${repo.id}`,
        );
        if (!result.ok) console.error("Repository cleanup failed", repo.id, result.status);
        else
            await env.DB.prepare("UPDATE repositories SET last_maintenance_at=? WHERE id=?")
                .bind(Date.now(), repo.id)
                .run();
    }
    const garbage = await env.DB.prepare(
        "SELECT g.* FROM garbage g WHERE g.not_before<=? AND NOT EXISTS (SELECT 1 FROM files f WHERE f.object_key=g.object_key) LIMIT 100",
    )
        .bind(Date.now())
        .all<{ object_key: string; multipart_id: string | null }>();
    for (const object of garbage.results) {
        if (object.multipart_id) {
            try {
                await env.BUCKET.resumeMultipartUpload(
                    object.object_key,
                    object.multipart_id,
                ).abort();
            } catch (error) {
                if (!/does not exist|not found|NoSuchUpload/i.test(String(error))) throw error;
            }
        }
        await env.BUCKET.delete(object.object_key);
        await env.DB.prepare("DELETE FROM garbage WHERE object_key=?")
            .bind(object.object_key)
            .run();
    }
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?")
        .bind(Date.now() - 60_000)
        .run();
}
