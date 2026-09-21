import type { Principal } from "./security";
import type { RepositoryCoordinator } from "./coordinator";
import type { MatchedRepository, RepositoryMapping } from "./repository-mappings";

export interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    REPOSITORIES: DurableObjectNamespace<RepositoryCoordinator>;
    ASSETS: Fetcher;
    APP_URL: string;
    REPOSITORY_MAPPINGS?: RepositoryMapping[];
    INSTANCE_MODE: "single" | "multi";
    SIGNUP_MODE: "closed" | "invite" | "open";
    ALLOW_ACCOUNT_CREATION: string;
    DEFAULT_ACCOUNT_SLUG: string;
    DEFAULT_ACCOUNT_NAME: string;
    ADMIN_GITHUB_IDS: string;
    MAX_FILE_BYTES: string;
    MAX_ACCOUNT_BYTES: string;
    BETTER_AUTH_SECRET: string;
    BOOTSTRAP_TOKEN?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    OIDC_DISCOVERY_URL?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_CLIENT_SECRET?: string;
}
export type AppEnv = {
    Bindings: Env;
    Variables: {
        principal: Principal | null;
        requestId: string;
        repositoryMapping?: MatchedRepository;
    };
};
