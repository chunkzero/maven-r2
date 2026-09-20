import { z } from "zod";
import { slug } from "@maven-r2/contracts";
import type { Env } from "./env";
import { fail } from "./security";

const reservedPaths = new Set(["api", "maven", "console", "health", "invite"]);
const mappingSchema = z.object({ url: z.url(), account: slug, repository: slug });
const mappingsSchema = z.array(mappingSchema);
export type RepositoryMapping = z.infer<typeof mappingSchema>;

function mappings(env: Env) {
    const parsed = mappingsSchema.safeParse(env.REPOSITORY_MAPPINGS ?? []);
    if (!parsed.success) throw new Error("Invalid REPOSITORY_MAPPINGS configuration");
    const seen = new Set<string>();
    return parsed.data.map((mapping) => {
        const url = new URL(mapping.url);
        const path = url.pathname.replace(/\/$/, "");
        const segments = path.split("/").slice(1);
        if (
            (url.protocol !== "https:" &&
                !(
                    url.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                )) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (path && !segments.every((segment) => /^[A-Za-z0-9_+.-]+$/.test(segment))) ||
            reservedPaths.has(segments[0] ?? "")
        )
            throw new Error(
                "Repository mappings require HTTPS URLs with unreserved paths (HTTP is allowed on loopback)",
            );
        const base = url.origin + path;
        if (seen.has(base)) throw new Error("Duplicate repository mapping URL: " + base);
        seen.add(base);
        return { ...mapping, url: base, origin: url.origin, path };
    });
}

export function matchRepositoryMapping(env: Env, url: URL) {
    const configured = mappings(env);
    let path: string;
    try {
        path = decodeURIComponent(url.pathname);
    } catch {
        fail(400, "Invalid artifact path");
    }
    if (reservedPaths.has(path.split("/")[1] ?? "")) return;
    const mapping = configured
        .filter(
            (mapping) =>
                mapping.origin === url.origin &&
                (path === mapping.path || path.startsWith(mapping.path + "/")),
        )
        .sort((a, b) => b.path.length - a.path.length)[0];
    if (mapping)
        return {
            account: mapping.account,
            repository: mapping.repository,
            path: path.slice(mapping.path.length + 1),
        };
}

export function repositoryUrl(env: Env, account: string, repository: string) {
    return (
        mappings(env).find(
            (mapping) => mapping.account === account && mapping.repository === repository,
        )?.url ?? `${new URL(env.APP_URL).origin}/maven/${account}/${repository}`
    );
}
