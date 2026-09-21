import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { repositoryInput, role, slug, tokenInput, type Scope } from "@maven-r2/contracts";
import type { AppEnv, Env } from "./env";
import { coordinatorRequest } from "./publications";
import {
    accountView,
    audit,
    fileView,
    publicationView,
    repositoryView,
    tokenView,
    type AccountRow,
    type FileRow,
    type PublicationRow,
    type RepositoryRow,
    type ServiceAccountRow,
    type TokenRow,
} from "./db";
import {
    accountRole,
    canonicalPath,
    fail,
    getAccount,
    getRepository,
    hash,
    newSecret,
    requireAdmin,
    requireUser,
    roleAllows,
} from "./security";

const createAccount = z.object({ slug, name: z.string().min(1).max(100) });
const repoPath = "/api/accounts/:account/repositories/:repository" as const;
const repositoryJson = async (env: Env, account: string, slug: string) =>
    repositoryView(env, account, (await getRepository(env, account, slug)).repository);

export function registerManagement(app: OpenAPIHono<AppEnv>) {
    app.get("/api/config", (c) =>
        c.json({
            instanceMode: c.env.INSTANCE_MODE,
            signupMode: c.env.SIGNUP_MODE,
            allowAccountCreation: c.env.ALLOW_ACCOUNT_CREATION === "true",
            defaultAccountSlug: c.env.DEFAULT_ACCOUNT_SLUG,
            githubEnabled: !!c.env.GITHUB_CLIENT_ID,
            oidcEnabled: !!c.env.OIDC_CLIENT_ID,
        }),
    );
    app.get("/api/me", async (c) => {
        const user = c.get("principal")?.user;
        if (user?.admin) {
            const account = await c.env.DB.prepare("SELECT id FROM accounts WHERE slug=?")
                .bind(c.env.DEFAULT_ACCOUNT_SLUG)
                .first<{ id: string }>();
            if (account)
                await c.env.DB.prepare(
                    "INSERT OR IGNORE INTO members (account_id,user_id,role) VALUES (?,?,'owner')",
                )
                    .bind(account.id, user.id)
                    .run();
        }
        return c.json({
            user: user
                ? {
                      id: user.id,
                      name: user.name,
                      email: user.email,
                      image: user.image,
                      admin: user.admin,
                  }
                : null,
        });
    });
    app.get("/api/accounts", async (c) => {
        const principal = c.get("principal");
        const admin = principal?.user?.admin ?? false;
        const rows = await c.env.DB.prepare(
            "SELECT a.*,m.role AS viewer_role FROM accounts a LEFT JOIN members m ON m.account_id=a.id AND m.user_id=? WHERE (a.suspended=0 OR ?=1) AND (?=1 OR m.user_id IS NOT NULL OR a.id=? OR EXISTS (SELECT 1 FROM repositories r WHERE r.account_id=a.id AND r.visibility='public')) ORDER BY a.name LIMIT 200",
        )
            .bind(
                principal?.user?.id ?? null,
                admin ? 1 : 0,
                admin ? 1 : 0,
                principal?.token?.account_id ?? null,
            )
            .all<AccountRow & { viewer_role: import("@maven-r2/contracts").Role | null }>();
        const result = [];
        for (const account of rows.results) {
            const memberRole = admin
                ? "owner"
                : principal?.token
                  ? await accountRole(c.env, principal, account.id)
                  : account.viewer_role;
            result.push(
                accountView(
                    memberRole
                        ? account
                        : { ...account, used_bytes: 0, reserved_bytes: 0, max_bytes: 0 },
                    memberRole,
                ),
            );
        }
        return c.json(result);
    });
    app.post("/api/accounts", async (c) => {
        const user = requireUser(c),
            input = createAccount.parse(await c.req.json());
        if (
            c.env.INSTANCE_MODE === "single" ||
            (c.env.ALLOW_ACCOUNT_CREATION !== "true" && !user.admin)
        )
            fail(403, "Account creation is disabled");
        const id = crypto.randomUUID(),
            now = Date.now();
        try {
            await c.env.DB.batch([
                c.env.DB.prepare(
                    "INSERT INTO accounts (id,slug,name,max_bytes,created_at) VALUES (?,?,?,?,?)",
                ).bind(id, input.slug, input.name, Number(c.env.MAX_ACCOUNT_BYTES), now),
                c.env.DB.prepare(
                    "INSERT INTO members (account_id,user_id,role) VALUES (?,?,'owner')",
                ).bind(id, user.id),
                audit(c.env, id, c.get("principal")!.actor, "account.created", input.slug),
            ]);
        } catch (error) {
            if (String(error).includes("UNIQUE constraint"))
                fail(409, "Account slug is already taken");
            throw error;
        }
        return c.json(accountView(await getAccount(c.env, input.slug), "owner"), 201);
    });
    app.get("/api/accounts/:account/repositories", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        const rows = await c.env.DB.prepare(
            "SELECT * FROM repositories WHERE account_id=? ORDER BY slug",
        )
            .bind(account.id)
            .all<RepositoryRow>();
        const principal = c.get("principal"),
            memberRole = await accountRole(c.env, principal, account.id);
        return c.json(
            rows.results
                .filter(
                    (repo) =>
                        repo.visibility === "public" ||
                        (memberRole &&
                            (!principal?.token ||
                                (JSON.parse(principal.token.scopes) as Scope[]).some(
                                    (scope) => scope.repository === repo.slug,
                                ))),
                )
                .map((repo) => repositoryView(c.env, account.slug, repo)),
        );
    });
    app.post("/api/accounts/:account/repositories", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        const input = repositoryInput.parse(await c.req.json());
        if (input.maxFileBytes > Number(c.env.MAX_FILE_BYTES))
            fail(400, "File limit exceeds the instance limit");
        const id = crypto.randomUUID();
        try {
            await c.env.DB.batch([
                c.env.DB.prepare(
                    "INSERT INTO repositories (id,account_id,slug,name,visibility,policy,max_file_bytes,retention_days,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                ).bind(
                    id,
                    account.id,
                    input.slug,
                    input.name,
                    input.visibility,
                    input.policy,
                    input.maxFileBytes,
                    input.retentionDays,
                    Date.now(),
                ),
                audit(
                    c.env,
                    account.id,
                    c.get("principal")!.actor,
                    "repository.created",
                    input.slug,
                ),
            ]);
        } catch (error) {
            if (String(error).includes("UNIQUE constraint"))
                fail(409, "Repository slug is already taken");
            throw error;
        }
        return c.json(await repositoryJson(c.env, account.slug, input.slug), 201);
    });
    app.patch(repoPath, async (c) => {
        const { account, repository } = await getRepository(
            c.env,
            c.req.param("account"),
            c.req.param("repository"),
        );
        await requireAdmin(c, account.id);
        const input = repositoryInput.omit({ slug: true }).parse(await c.req.json());
        if (input.maxFileBytes > Number(c.env.MAX_FILE_BYTES))
            fail(400, "File limit exceeds the instance limit");
        await c.env.DB.batch([
            c.env.DB.prepare(
                "UPDATE repositories SET name=?,visibility=?,policy=?,max_file_bytes=?,retention_days=? WHERE id=?",
            ).bind(
                input.name,
                input.visibility,
                input.policy,
                input.maxFileBytes,
                input.retentionDays,
                repository.id,
            ),
            audit(
                c.env,
                account.id,
                c.get("principal")!.actor,
                "repository.updated",
                repository.slug,
            ),
        ]);
        return c.json(await repositoryJson(c.env, account.slug, repository.slug));
    });
    app.get("/api/accounts/:account/repositories/:repository/files", async (c) => {
        const { repository } = await getRepository(
            c.env,
            c.req.param("account"),
            c.req.param("repository"),
        );
        const prefix = canonicalPath(c.req.query("prefix") ?? "", true),
            search = (c.req.query("q") ?? "").slice(0, 100),
            after = c.req.query("after") ?? "";
        const lower = prefix ? prefix + "/" : "",
            upper = prefix ? prefix + "/\uffff" : "\uffff";
        const principal = c.get("principal");
        const memberRole = await accountRole(c.env, principal, repository.account_id);
        const binds: (string | number)[] = [repository.id, lower, upper, after, search];
        let filter = "";
        if (repository.visibility !== "public") {
            if (!memberRole) fail(principal ? 403 : 401, "Read access required");
            if (principal?.token) {
                const scopes = JSON.parse(principal.token.scopes) as Scope[];
                const prefixes = scopes
                    .filter(
                        (scope) =>
                            scope.repository === repository.slug && scope.actions.includes("read"),
                    )
                    .flatMap((scope) => scope.prefixes);
                if (!prefixes.length) fail(403, "Read access required");
                if (!prefixes.includes("")) {
                    filter =
                        " AND (" +
                        prefixes
                            .map((prefix) => {
                                binds.push(prefix, prefix + "/", prefix + "/\uffff");
                                return "(path=? OR (path>=? AND path<?))";
                            })
                            .join(" OR ") +
                        ")";
                }
            }
        }
        const rows = await c.env.DB.prepare(
            "SELECT * FROM files WHERE repository_id=? AND path>=? AND path<? AND path>? AND instr(path,?)>0" +
                filter +
                " ORDER BY path LIMIT 501",
        )
            .bind(...binds)
            .all<FileRow>();
        return c.json({
            files: rows.results.slice(0, 500).map(fileView),
            next: rows.results.length > 500 ? rows.results[499]!.path : null,
        });
    });
    app.post("/api/accounts/:account/repositories/:repository/delete-version", async (c) => {
        const { repository } = await getRepository(
            c.env,
            c.req.param("account"),
            c.req.param("repository"),
        );
        const input = z.object({ path: z.string() }).parse(await c.req.json());
        const response = await coordinatorRequest(
            c.env,
            repository.id,
            `/delete/${repository.id}`,
            new Request(c.req.url, {
                method: "POST",
                headers: c.req.raw.headers,
                body: JSON.stringify(input),
            }),
        );
        return new Response(response.body, response);
    });
    app.post(
        "/api/accounts/:account/repositories/:repository/publications/:id/abort",
        async (c) => {
            const { account, repository } = await getRepository(
                c.env,
                c.req.param("account"),
                c.req.param("repository"),
            );
            await requireAdmin(c, account.id);
            const publication = await c.env.DB.prepare(
                "SELECT id FROM publications WHERE id=? AND repository_id=?",
            )
                .bind(c.req.param("id"), repository.id)
                .first();
            if (!publication) fail(404, "Publication not found");
            const response = await coordinatorRequest(
                c.env,
                repository.id,
                `/admin-abort/${c.req.param("id")}`,
                new Request(c.req.url, { method: "POST", headers: c.req.raw.headers }),
            );
            return new Response(response.body, response);
        },
    );
    app.get("/api/accounts/:account/repositories/:repository/publications", async (c) => {
        const { account, repository } = await getRepository(
            c.env,
            c.req.param("account"),
            c.req.param("repository"),
        );
        if (
            !(await accountRole(c.env, c.get("principal"), account.id)) ||
            c.get("principal")?.token
        )
            fail(403, "Account membership required");
        const rows = await c.env.DB.prepare(
            "SELECT * FROM publications WHERE repository_id=? ORDER BY created_at DESC LIMIT 100",
        )
            .bind(repository.id)
            .all<PublicationRow>();
        return c.json(rows.results.map(publicationView));
    });
    app.get("/api/accounts/:account/tokens", async (c) => {
        const account = await getAccount(c.env, c.req.param("account")),
            user = requireUser(c);
        const memberRole = await accountRole(c.env, c.get("principal"), account.id);
        if (!memberRole) fail(403, "Account membership required");
        const admin = memberRole === "owner" || memberRole === "admin";
        const rows = await c.env.DB.prepare(
            admin
                ? "SELECT * FROM tokens WHERE account_id=? ORDER BY created_at DESC"
                : "SELECT * FROM tokens WHERE account_id=? AND user_id=? ORDER BY created_at DESC",
        )
            .bind(...(admin ? [account.id] : [account.id, user.id]))
            .all<TokenRow>();
        return c.json(rows.results.map(tokenView));
    });
    app.post("/api/accounts/:account/tokens", async (c) => {
        const account = await getAccount(c.env, c.req.param("account")),
            user = requireUser(c),
            input = tokenInput.parse(await c.req.json());
        let memberRole = await accountRole(c.env, c.get("principal"), account.id);
        if (!memberRole) fail(403, "Account membership required");
        if (
            !input.serviceAccountId &&
            !(await c.env.DB.prepare("SELECT 1 FROM members WHERE account_id=? AND user_id=?")
                .bind(account.id, user.id)
                .first())
        )
            fail(
                403,
                "Join this workspace before creating a personal token, or use a service account",
            );
        if (input.serviceAccountId) {
            await requireAdmin(c, account.id);
            const service = await c.env.DB.prepare(
                "SELECT * FROM service_accounts WHERE id=? AND account_id=? AND disabled=0",
            )
                .bind(input.serviceAccountId, account.id)
                .first<ServiceAccountRow>();
            if (!service) fail(404, "Service account not found");
            memberRole = service.role;
        }
        if (input.expiresAt !== null && input.expiresAt <= Date.now())
            fail(400, "Token expiry must be in the future");
        if (input.scopes.reduce((count, scope) => count + scope.prefixes.length, 0) > 20)
            fail(400, "A token may contain at most 20 path prefixes");
        for (const scope of input.scopes) {
            await getRepository(c.env, account.slug, scope.repository);
            scope.prefixes = scope.prefixes.map((prefix) => canonicalPath(prefix, true));
            if (scope.actions.some((action) => !roleAllows(memberRole, action)))
                fail(403, "Token scope exceeds its owner's permissions");
        }
        const secret = newSecret(),
            id = crypto.randomUUID();
        await c.env.DB.batch([
            c.env.DB.prepare(
                "INSERT INTO tokens (id,account_id,user_id,service_account_id,name,prefix,hash,scopes,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ).bind(
                id,
                account.id,
                input.serviceAccountId ? null : user.id,
                input.serviceAccountId ?? null,
                input.name,
                secret.slice(0, 12),
                await hash(secret),
                JSON.stringify(input.scopes),
                input.expiresAt,
                Date.now(),
            ),
            audit(c.env, account.id, c.get("principal")!.actor, "token.created", id),
        ]);
        return c.json(
            {
                secret,
                token: tokenView(
                    (await c.env.DB.prepare("SELECT * FROM tokens WHERE id=?")
                        .bind(id)
                        .first<TokenRow>())!,
                ),
            },
            201,
        );
    });
    app.delete("/api/accounts/:account/tokens/:token", async (c) => {
        const account = await getAccount(c.env, c.req.param("account")),
            user = requireUser(c);
        const token = await c.env.DB.prepare("SELECT * FROM tokens WHERE id=? AND account_id=?")
            .bind(c.req.param("token"), account.id)
            .first<TokenRow>();
        if (!token) fail(404, "Token not found");
        if (token.user_id !== user.id) await requireAdmin(c, account.id);
        await c.env.DB.batch([
            c.env.DB.prepare("UPDATE tokens SET revoked=1 WHERE id=?").bind(token.id),
            audit(c.env, account.id, c.get("principal")!.actor, "token.revoked", token.id),
        ]);
        return c.json({ ok: true });
    });
    app.get("/api/accounts/:account/members", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        return c.json(
            (
                await c.env.DB.prepare(
                    "SELECT m.user_id AS userId,u.name,u.email,m.role FROM members m JOIN auth_users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY u.name",
                )
                    .bind(account.id)
                    .all()
            ).results,
        );
    });
    app.patch("/api/accounts/:account/members/:user", async (c) => {
        const account = await getAccount(c.env, c.req.param("account")),
            actorRole = await requireAdmin(c, account.id);
        const input = z.object({ role }).parse(await c.req.json());
        const member = await c.env.DB.prepare(
            "SELECT role FROM members WHERE account_id=? AND user_id=?",
        )
            .bind(account.id, c.req.param("user"))
            .first<{ role: string }>();
        if (!member) fail(404, "Member not found");
        if ((member.role === "owner" || input.role === "owner") && actorRole !== "owner")
            fail(403, "Only owners can manage owners");
        const result = await c.env.DB.prepare(
            "UPDATE members SET role=? WHERE account_id=? AND user_id=? AND (role!='owner' OR ?='owner' OR (SELECT count(*) FROM members WHERE account_id=? AND role='owner')>1)",
        )
            .bind(input.role, account.id, c.req.param("user"), input.role, account.id)
            .run();
        if (!result.meta.changes) fail(409, "An account must retain an owner");
        await audit(
            c.env,
            account.id,
            c.get("principal")!.actor,
            "member.updated",
            c.req.param("user"),
        ).run();
        return c.json({ ok: true });
    });
    app.delete("/api/accounts/:account/members/:user", async (c) => {
        const account = await getAccount(c.env, c.req.param("account")),
            actorRole = await requireAdmin(c, account.id);
        const member = await c.env.DB.prepare(
            "SELECT role FROM members WHERE account_id=? AND user_id=?",
        )
            .bind(account.id, c.req.param("user"))
            .first<{ role: string }>();
        if (!member) fail(404, "Member not found");
        if (member.role === "owner" && actorRole !== "owner")
            fail(403, "Only owners can remove owners");
        const result = await c.env.DB.prepare(
            "DELETE FROM members WHERE account_id=? AND user_id=? AND (role!='owner' OR (SELECT count(*) FROM members WHERE account_id=? AND role='owner')>1)",
        )
            .bind(account.id, c.req.param("user"), account.id)
            .run();
        if (!result.meta.changes) fail(409, "An account must retain an owner");
        await audit(
            c.env,
            account.id,
            c.get("principal")!.actor,
            "member.removed",
            c.req.param("user"),
        ).run();
        return c.json({ ok: true });
    });
    app.get("/api/accounts/:account/services", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        return c.json(
            (
                await c.env.DB.prepare(
                    "SELECT * FROM service_accounts WHERE account_id=? ORDER BY name",
                )
                    .bind(account.id)
                    .all<ServiceAccountRow>()
            ).results.map((row) => ({
                id: row.id,
                name: row.name,
                role: row.role,
                disabled: !!row.disabled,
            })),
        );
    });
    app.post("/api/accounts/:account/services", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        const input = z
                .object({ name: z.string().min(1).max(100), role: z.enum(["publisher", "reader"]) })
                .parse(await c.req.json()),
            id = crypto.randomUUID();
        await c.env.DB.batch([
            c.env.DB.prepare(
                "INSERT INTO service_accounts (id,account_id,name,role) VALUES (?,?,?,?)",
            ).bind(id, account.id, input.name, input.role),
            audit(c.env, account.id, c.get("principal")!.actor, "service.created", id),
        ]);
        return c.json({ id, ...input, disabled: false }, 201);
    });
    app.delete("/api/accounts/:account/services/:service", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        await c.env.DB.batch([
            c.env.DB.prepare(
                "UPDATE service_accounts SET disabled=1 WHERE account_id=? AND id=?",
            ).bind(account.id, c.req.param("service")),
            audit(
                c.env,
                account.id,
                c.get("principal")!.actor,
                "service.disabled",
                c.req.param("service"),
            ),
        ]);
        return c.json({ ok: true });
    });
    app.get("/api/accounts/:account/invitations", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        const rows = await c.env.DB.prepare(
            "SELECT id,email,role,expires_at AS expiresAt,accepted FROM invitations WHERE account_id=? ORDER BY expires_at DESC LIMIT 100",
        )
            .bind(account.id)
            .all<{
                id: string;
                email: string;
                role: string;
                expiresAt: number;
                accepted: number;
            }>();
        return c.json(rows.results.map((row) => ({ ...row, accepted: !!row.accepted })));
    });
    app.post("/api/accounts/:account/invitations", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        const input = z
            .object({ email: z.email(), role: z.enum(["admin", "publisher", "reader"]) })
            .parse(await c.req.json());
        const secret = newSecret(),
            id = crypto.randomUUID(),
            expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await c.env.DB.batch([
            c.env.DB.prepare(
                "INSERT INTO invitations (id,account_id,email,role,secret_hash,expires_at) VALUES (?,?,?,?,?,?)",
            ).bind(
                id,
                account.id,
                input.email.toLowerCase(),
                input.role,
                await hash(secret),
                expires,
            ),
            audit(c.env, account.id, c.get("principal")!.actor, "invitation.created", id),
        ]);
        return c.json(
            {
                id,
                url: new URL("/console/invite/" + secret, c.env.APP_URL).href,
                expiresAt: expires,
            },
            201,
        );
    });
    app.delete("/api/accounts/:account/invitations/:id", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        await c.env.DB.batch([
            c.env.DB.prepare(
                "DELETE FROM invitations WHERE account_id=? AND id=? AND accepted=0",
            ).bind(account.id, c.req.param("id")),
            audit(
                c.env,
                account.id,
                c.get("principal")!.actor,
                "invitation.revoked",
                c.req.param("id"),
            ),
        ]);
        return c.json({ ok: true });
    });
    app.post("/api/invitations/accept", async (c) => {
        const user = requireUser(c),
            input = z.object({ secret: z.string() }).parse(await c.req.json());
        if (!user.emailVerified) fail(403, "A verified email address is required");
        const invite = await c.env.DB.prepare(
            "SELECT * FROM invitations WHERE secret_hash=? AND accepted=0 AND expires_at>? AND email=?",
        )
            .bind(await hash(input.secret), Date.now(), user.email.toLowerCase())
            .first<{ id: string; account_id: string; role: string }>();
        if (!invite) fail(404, "Invitation not found or expired");
        await c.env.DB.batch([
            c.env.DB.prepare(
                "INSERT INTO members (account_id,user_id,role) VALUES (?,?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role WHERE role!='owner'",
            ).bind(invite.account_id, user.id, invite.role),
            c.env.DB.prepare("UPDATE invitations SET accepted=1 WHERE id=?").bind(invite.id),
            audit(
                c.env,
                invite.account_id,
                c.get("principal")!.actor,
                "invitation.accepted",
                invite.id,
            ),
        ]);
        return c.json({ ok: true });
    });
    app.get("/api/accounts/:account/audit", async (c) => {
        const account = await getAccount(c.env, c.req.param("account"));
        await requireAdmin(c, account.id);
        return c.json(
            (
                await c.env.DB.prepare(
                    "SELECT id,actor,action,target,created_at AS createdAt FROM audit_events WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
                )
                    .bind(account.id)
                    .all()
            ).results,
        );
    });
    app.patch("/api/admin/accounts/:id", async (c) => {
        if (!requireUser(c).admin) fail(403, "Instance administrator required");
        const input = z
            .object({ suspended: z.boolean(), maxBytes: z.number().int().positive() })
            .parse(await c.req.json());
        try {
            await c.env.DB.batch([
                c.env.DB.prepare("UPDATE accounts SET suspended=?,max_bytes=? WHERE id=?").bind(
                    input.suspended ? 1 : 0,
                    input.maxBytes,
                    c.req.param("id"),
                ),
                audit(
                    c.env,
                    c.req.param("id"),
                    c.get("principal")!.actor,
                    "account.policy.updated",
                    c.req.param("id"),
                ),
            ]);
        } catch (error) {
            if (String(error).includes("CHECK constraint"))
                fail(409, "Quota cannot be lower than current storage and reservations");
            throw error;
        }
        return c.json({ ok: true });
    });
}
