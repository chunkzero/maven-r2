import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Action, Role, Scope } from "@maven-r2/contracts";
import type { AppEnv, Env } from "./env";
import type { AccountRow, RepositoryRow, ServiceAccountRow, TokenRow } from "./db";
import { auth, isInstanceAdmin } from "./auth";

export interface Principal {
    actor: string;
    roles?: Map<string, Role | null>;
    user?: {
        id: string;
        name: string;
        email: string;
        image: string | null;
        admin: boolean;
        emailVerified: boolean;
    };
    token?: TokenRow;
}
export function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 429, message: string): never {
    throw new HTTPException(status, { message });
}
export function canonicalPath(path: string, prefix = false): string {
    const clean = prefix ? path.replace(/\/$/, "") : path;
    if (prefix && clean === "") return "";
    if (
        clean.length > 1024 ||
        !clean
            .split("/")
            .every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9_+.-]+$/.test(part))
    )
        fail(400, "Invalid repository path");
    return clean;
}
export function within(path: string, prefix: string): boolean {
    return prefix === "" || path === prefix || path.startsWith(prefix + "/");
}
export async function hash(secret: string): Promise<string> {
    return Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))),
        (v) => v.toString(16).padStart(2, "0"),
    ).join("");
}
export function newSecret(): string {
    return (
        "mr2_" +
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
            v.toString(16).padStart(2, "0"),
        ).join("")
    );
}
export async function authenticate(request: Request, env: Env): Promise<Principal | null> {
    const authorization = request.headers.get("authorization");
    if (authorization) {
        let secret = "";
        if (authorization.startsWith("Bearer ")) secret = authorization.slice(7);
        else if (authorization.startsWith("Basic ")) {
            try {
                const decoded = atob(authorization.slice(6));
                secret = decoded.slice(decoded.indexOf(":") + 1);
            } catch {
                fail(401, "Invalid credentials");
            }
        }
        if (!secret.startsWith("mr2_")) fail(401, "Invalid credentials");
        const token = await env.DB.prepare(
            "SELECT * FROM tokens WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)",
        )
            .bind(await hash(secret), Date.now())
            .first<TokenRow>();
        if (!token) fail(401, "Token expired or revoked");
        const principal = {
            actor: token.user_id ? "user:" + token.user_id : "service:" + token.service_account_id,
            token,
        };
        if (!(await accountRole(env, principal, token.account_id)))
            fail(401, "Token owner is no longer active");
        if (!token.last_used_at || Date.now() - token.last_used_at > 60_000)
            await env.DB.prepare("UPDATE tokens SET last_used_at=? WHERE id=?")
                .bind(Date.now(), token.id)
                .run();
        return principal;
    }
    if (!request.headers.get("cookie")) return null;
    const session = await auth(env).api.getSession({ headers: request.headers });
    if (!session) return null;
    return {
        actor: "user:" + session.user.id,
        user: {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
            image: session.user.image ?? null,
            emailVerified: session.user.emailVerified,
            admin: isInstanceAdmin(env, session.user.githubId),
        },
    };
}
export async function accountRole(
    env: Env,
    principal: Principal | null,
    accountId: string,
): Promise<Role | null> {
    if (!principal) return null;
    principal.roles ??= new Map();
    if (principal.roles.has(accountId)) return principal.roles.get(accountId)!;
    const role = await resolveAccountRole(env, principal, accountId);
    principal.roles.set(accountId, role);
    return role;
}
async function resolveAccountRole(
    env: Env,
    principal: Principal,
    accountId: string,
): Promise<Role | null> {
    if (!principal) return null;
    if (principal.user?.admin) return "owner";
    if (principal.token && principal.token.account_id !== accountId) return null;
    if (principal.token?.service_account_id) {
        const service = await env.DB.prepare(
            "SELECT * FROM service_accounts WHERE id=? AND account_id=? AND disabled=0",
        )
            .bind(principal.token.service_account_id, accountId)
            .first<ServiceAccountRow>();
        return service?.role ?? null;
    }
    const userId = principal.user?.id ?? principal.token?.user_id;
    if (!userId) return null;
    return (
        (
            await env.DB.prepare("SELECT role FROM members WHERE account_id=? AND user_id=?")
                .bind(accountId, userId)
                .first<{ role: Role }>()
        )?.role ?? null
    );
}
export function roleAllows(role: Role | null, action: Action): boolean {
    if (!role) return false;
    if (action === "read") return true;
    if (action === "delete") return role === "owner" || role === "admin";
    return role !== "reader";
}
export function tokenAllows(
    token: TokenRow,
    repo: RepositoryRow,
    action: Action,
    path: string,
): boolean {
    if (token.account_id !== repo.account_id) return false;
    const scopes = JSON.parse(token.scopes) as Scope[];
    return scopes.some(
        (scope) =>
            scope.repository === repo.slug &&
            scope.actions.includes(action) &&
            scope.prefixes.some((prefix) => within(path, prefix)),
    );
}
export async function canAccess(
    env: Env,
    principal: Principal | null,
    repo: RepositoryRow,
    action: Action,
    path: string,
): Promise<boolean> {
    if (action === "read" && repo.visibility === "public") return true;
    if (!roleAllows(await accountRole(env, principal, repo.account_id), action)) return false;
    return !principal?.token || tokenAllows(principal.token, repo, action, path);
}
export async function requireAccess(
    env: Env,
    principal: Principal | null,
    repo: RepositoryRow,
    action: Action,
    path: string,
) {
    if (!(await canAccess(env, principal, repo, action, path)))
        fail(principal ? 403 : 401, "This credential does not permit the requested operation");
}
export function requireUser(c: Context<AppEnv>) {
    const user = c.get("principal")?.user;
    if (!user) fail(401, "Sign in to manage your account");
    return user;
}
export async function requireAdmin(c: Context<AppEnv>, accountId: string) {
    requireUser(c);
    const role = await accountRole(c.env, c.get("principal"), accountId);
    if (role !== "owner" && role !== "admin") fail(403, "Account administrator required");
    return role;
}
export async function getAccount(env: Env, slug: string) {
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE slug=?")
        .bind(slug)
        .first<AccountRow>();
    if (!account || account.suspended) fail(404, "Account not found");
    return account;
}
export async function getRepository(env: Env, accountSlug: string, slug: string) {
    const account = await getAccount(env, accountSlug);
    const repository = await env.DB.prepare(
        "SELECT * FROM repositories WHERE account_id=? AND slug=?",
    )
        .bind(account.id, slug)
        .first<RepositoryRow>();
    if (!repository) fail(404, "Repository not found");
    return { account, repository };
}
export async function rateLimit(env: Env, key: string, limit: number, windowMs = 60_000) {
    const now = Date.now();
    const row = await env.DB.prepare(
        "INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING count",
    )
        .bind(key, now + windowMs, now, now, now + windowMs)
        .first<{ count: number }>();
    if (row && row.count > limit) fail(429, "Too many requests. Try again shortly.");
}
