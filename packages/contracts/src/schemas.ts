import { z } from "zod";

export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const role = z.enum(["owner", "admin", "publisher", "reader"]);
export const action = z.enum(["read", "publish:release", "publish:snapshot", "delete"]);
export const scope = z.object({
    repository: slug,
    prefixes: z.array(z.string().max(1024)).min(1).max(50),
    actions: z.array(action).min(1),
});
export const accountSchema = z.object({
    id: z.string(),
    slug,
    name: z.string(),
    role: role.nullable(),
    usedBytes: z.number().int(),
    reservedBytes: z.number().int(),
    maxBytes: z.number().int(),
    suspended: z.boolean(),
});
export const repositorySchema = z.object({
    id: z.string(),
    accountId: z.string(),
    slug,
    url: z.url(),
    name: z.string(),
    visibility: z.enum(["public", "private"]),
    policy: z.enum(["releases", "snapshots", "mixed"]),
    maxFileBytes: z.number().int(),
    retentionDays: z.number().int(),
    createdAt: z.number().int(),
});
export const repositoryInput = repositorySchema
    .pick({
        slug: true,
        name: true,
        visibility: true,
        policy: true,
        maxFileBytes: true,
        retentionDays: true,
    })
    .extend({
        name: z.string().min(1).max(100),
        maxFileBytes: z
            .number()
            .int()
            .min(1)
            .max(2 ** 40),
        retentionDays: z.number().int().min(0).max(3650),
    });
export const fileSchema = z.object({
    path: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    contentType: z.string(),
    publicationId: z.string(),
    updatedAt: z.number().int(),
});
export const publicationSchema = z.object({
    id: z.string(),
    repositoryId: z.string(),
    status: z.enum(["open", "committed", "aborted"]),
    label: z.string(),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    committedAt: z.number().int().nullable(),
});
export const uploadSchema = z.object({
    id: z.string(),
    path: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    status: z.enum(["pending", "complete"]),
    partSize: z.number().int(),
    parts: z.array(z.object({ number: z.number().int(), etag: z.string() })),
});
export const tokenSchema = z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(scope),
    serviceAccountId: z.string().nullable(),
    expiresAt: z.number().int().nullable(),
    lastUsedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    revoked: z.boolean(),
});
export const tokenInput = z.object({
    name: z.string().min(1).max(100),
    scopes: z.array(scope).min(1).max(20),
    serviceAccountId: z.string().optional(),
    expiresAt: z.number().int().positive().nullable(),
});
export const memberSchema = z.object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    role,
});
export const serviceAccountSchema = z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(["publisher", "reader"]),
    disabled: z.boolean(),
});
export const invitationSchema = z.object({
    id: z.string(),
    email: z.string(),
    role,
    expiresAt: z.number().int(),
    accepted: z.boolean(),
});
export const auditSchema = z.object({
    id: z.string(),
    actor: z.string(),
    action: z.string(),
    target: z.string(),
    createdAt: z.number().int(),
});
export const configSchema = z.object({
    instanceMode: z.enum(["single", "multi"]),
    signupMode: z.enum(["closed", "invite", "open"]),
    allowAccountCreation: z.boolean(),
    defaultAccountSlug: z.string(),
    githubEnabled: z.boolean(),
    oidcEnabled: z.boolean(),
});
export const meSchema = z.object({
    user: z
        .object({
            id: z.string(),
            name: z.string(),
            email: z.string(),
            image: z.string().nullable(),
            admin: z.boolean(),
        })
        .nullable(),
});
export const errorSchema = z.object({ error: z.string(), requestId: z.string().optional() });

export type Role = z.infer<typeof role>;
export type Scope = z.infer<typeof scope>;
export type Action = z.infer<typeof action>;
export type Account = z.infer<typeof accountSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type Upload = z.infer<typeof uploadSchema>;
