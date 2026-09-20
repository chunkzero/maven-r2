import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema";
import type { Env } from "./env";

export function isInstanceAdmin(env: Env, githubId: string | null | undefined): boolean {
    return (
        !!githubId &&
        env.ADMIN_GITHUB_IDS.split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .includes(githubId)
    );
}

export function auth(env: Env) {
    return betterAuth({
        appName: "Maven R2",
        baseURL: env.APP_URL,
        secret: env.BETTER_AUTH_SECRET,
        database: drizzleAdapter(drizzle(env.DB), {
            provider: "sqlite",
            schema,
            transaction: false,
        }),
        trustedOrigins: [env.APP_URL],
        socialProviders:
            env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
                ? {
                      github: {
                          clientId: env.GITHUB_CLIENT_ID,
                          clientSecret: env.GITHUB_CLIENT_SECRET,
                          mapProfileToUser: (profile) => ({ githubId: String(profile.id) }),
                      },
                  }
                : {},
        plugins:
            env.OIDC_DISCOVERY_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
                ? [
                      genericOAuth({
                          config: [
                              {
                                  providerId: "oidc",
                                  discoveryUrl: env.OIDC_DISCOVERY_URL,
                                  clientId: env.OIDC_CLIENT_ID,
                                  clientSecret: env.OIDC_CLIENT_SECRET,
                                  scopes: ["openid", "profile", "email"],
                                  pkce: true,
                              },
                          ],
                      }),
                  ]
                : [],
        user: { additionalFields: { githubId: { type: "string", required: false, input: false } } },
        session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
        account: { accountLinking: { enabled: false } },
        rateLimit: { enabled: true, storage: "memory", window: 60, max: 30 },
        databaseHooks: {
            user: {
                create: {
                    before: async (user) => {
                        const githubId = "githubId" in user ? String(user.githubId) : undefined;
                        if (isInstanceAdmin(env, githubId) || env.SIGNUP_MODE === "open")
                            return { data: user };
                        if (env.SIGNUP_MODE === "invite" && user.emailVerified) {
                            const invite = await env.DB.prepare(
                                "SELECT id FROM invitations WHERE lower(email)=? AND accepted=0 AND expires_at>?",
                            )
                                .bind(user.email.toLowerCase(), Date.now())
                                .first();
                            if (invite) return { data: user };
                        }
                        throw new APIError("FORBIDDEN", {
                            message: "Signups are disabled or require an invitation.",
                        });
                    },
                },
            },
        },
    });
}
