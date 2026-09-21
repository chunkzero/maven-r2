import type { Env } from "./env";
import type { Role, Scope } from "@maven-r2/contracts";
import { repositoryUrl } from "./repository-mappings";

export interface AccountRow {
    id: string;
    slug: string;
    name: string;
    used_bytes: number;
    reserved_bytes: number;
    max_bytes: number;
    suspended: number;
    created_at: number;
}
export interface RepositoryRow {
    id: string;
    account_id: string;
    slug: string;
    name: string;
    visibility: "public" | "private";
    policy: "releases" | "snapshots" | "mixed";
    max_file_bytes: number;
    retention_days: number;
    created_at: number;
}
export interface PublicationRow {
    id: string;
    repository_id: string;
    actor: string;
    token_id: string | null;
    status: "open" | "committed" | "aborted";
    label: string;
    created_at: number;
    expires_at: number;
    committed_at: number | null;
}
export interface UploadRow {
    id: string;
    publication_id: string;
    path: string;
    object_key: string;
    size: number;
    sha256: string;
    status: "pending" | "complete";
    multipart_id: string | null;
    checksums: string | null;
}
export interface FileRow {
    repository_id: string;
    path: string;
    object_key: string;
    size: number;
    sha256: string;
    checksums: string;
    publication_id: string;
    updated_at: number;
}
export interface TokenRow {
    id: string;
    account_id: string;
    user_id: string | null;
    service_account_id: string | null;
    name: string;
    prefix: string;
    hash: string;
    scopes: string;
    expires_at: number | null;
    last_used_at: number | null;
    created_at: number;
    revoked: number;
}
export interface ServiceAccountRow {
    id: string;
    account_id: string;
    name: string;
    role: "publisher" | "reader";
    disabled: number;
}
export const accountView = (row: AccountRow, role: Role | null = null) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    role,
    usedBytes: row.used_bytes,
    reservedBytes: row.reserved_bytes,
    maxBytes: row.max_bytes,
    suspended: !!row.suspended,
});
export const repositoryView = (env: Env, account: string, row: RepositoryRow) => ({
    id: row.id,
    accountId: row.account_id,
    slug: row.slug,
    url: repositoryUrl(env, account, row.slug),
    name: row.name,
    visibility: row.visibility,
    policy: row.policy,
    maxFileBytes: row.max_file_bytes,
    retentionDays: row.retention_days,
    createdAt: row.created_at,
});
export const publicationView = (row: PublicationRow) => ({
    id: row.id,
    repositoryId: row.repository_id,
    status: row.status,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    committedAt: row.committed_at,
});
export const tokenView = (row: TokenRow) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes) as Scope[],
    serviceAccountId: row.service_account_id,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revoked: !!row.revoked,
});
export const fileView = (row: FileRow) => ({
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    contentType: contentType(row.path),
    publicationId: row.publication_id,
    updatedAt: row.updated_at,
});
export function contentType(path: string): string {
    if (path.endsWith(".pom") || path.endsWith(".xml")) return "application/xml";
    if (path.endsWith(".module") || path.endsWith(".json")) return "application/json";
    if (/\.(sha1|sha256|sha512|md5|asc)$/.test(path)) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}
export function audit(env: Env, accountId: string, actor: string, action: string, target: string) {
    return env.DB.prepare(
        "INSERT INTO audit_events (id,account_id,actor,action,target,created_at) VALUES (?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), accountId, actor, action, target, Date.now());
}
