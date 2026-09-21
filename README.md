# Maven R2

A Maven repository backed by Cloudflare R2, with a standalone Go publishing client and a small web console.

**Publish through the local proxy. Download directly from the hosted repository.** Maven and Gradle use normal HTTP repository protocols; they never receive R2 credentials. A publication becomes visible only after the entire build succeeds and the Worker validates its artifacts.

## What is implemented

- Release, snapshot, and mixed repositories; public or private visibility.
- Atomic publication sessions, immutable releases and timestamped snapshots, concurrent metadata merging, resumable multipart uploads, and failed-build rollback.
- Maven POMs, parent POMs, Gradle module metadata, classifiers, detached signatures, and MD5/SHA-1/SHA-256/SHA-512 sidecars. The server verifies supplied checksums and generates checksums for its own metadata.
- Direct downloads with Basic or Bearer token authentication, conditional GET, HEAD, and byte ranges. Public repositories need no credentials.
- Configurable repository URLs, including a release repository at the domain root and snapshots at `/snapshots`, in single- or multiple-workspace instances.
- Single-workspace or multiple-workspace instances, GitHub login, optional OIDC, configurable signups, invitation links, and owner/admin/publisher/reader roles.
- Personal tokens and service-account tokens restricted by repository, path prefix, operation, and expiry. Tokens are stored as hashes and shown once. Revocation, removal of membership, and disabled service accounts take effect on subsequent requests.
- A responsive light/dark console for artifact browsing, path search, dependency snippets, publication history, version deletion, repository settings, members, invitations, service accounts, tokens, usage, and audit history.
- Account storage quotas, upload reservations, snapshot retention, abandoned-session expiry, delayed garbage collection, and request rate limits.

## Architecture and upload choice

| Part                  | Stack                                      | Responsibility                                                                          |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `cli/`, `internal/`   | Go, Kong, generated OpenAPI client         | Loopback Maven proxy, local spooling, upload retries, build execution, session recovery |
| `apps/worker/`        | Hono, Zod, Better Auth, Drizzle, Workers   | Authentication, permissions, publishing API, downloads, maintenance                     |
| `apps/web/`           | React, React Router, TanStack Query, Vite+ | Repository and account console, served as Worker static assets                          |
| `packages/contracts/` | Zod and OpenAPI                            | Shared TypeScript schemas and generated Go API contracts                                |

**The Worker handles uploads.** The CLI sends 16 MiB parts to the Worker, which streams them into a private R2 bucket. R2 holds immutable objects; D1 maps published Maven paths to those objects. A Durable Object serializes mutations for each repository, and a D1 transaction publishes all file references and merged metadata together. Readers never see a partially finalized publication.

| Approach                      | Advantages                                                                                   | Costs                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Presigned R2 uploads          | Artifact bytes bypass Worker execution; useful for very large transfers                      | Requires S3 signing credentials, grants remain usable until expiry, multipart coordination and final validation are still needed |
| Worker streaming, implemented | Binding-based R2 access, immediate authorization checks, one protocol and deployment surface | More Worker requests; full-file checksum validation reads uploaded bytes again; CPU and D1 limits need capacity planning         |

The part size keeps individual requests below normal Worker request-body limits. This implementation targets **Workers Paid** for finalization and checksum-validation budgets; review [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) for your workload. A future presigned transport can use the same staging and commit model without changing build configuration.

## Development

Install [mise](https://mise.jdx.dev/), then:

```sh
mise trust
mise install
mise exec -- just setup
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
mise exec -- pnpm db:migrate
mise exec -- just dev
```

Open **http://localhost:5173/#/**. Vite+ serves the console page at `/` and forwards other paths to the local Worker on port 8787, including mapped repository URLs. Wrangler emulates D1, R2, and Durable Objects locally. The example secrets are for local development only.

Initialize the local instance once:

```sh
curl --fail-with-body -X POST http://localhost:5173/api/bootstrap \
  -H 'x-bootstrap-token: local-bootstrap-only-replace-before-deploy'
```

This creates the default workspace, private `releases` and `snapshots` repositories, and a bootstrap publishing token valid for 24 hours. Save the token from the response. To access the management UI, configure a development GitHub OAuth app in `.dev.vars` and put your numeric GitHub user ID in `ADMIN_GITHUB_IDS` in `wrangler.jsonc`. Its callback URL is `http://localhost:5173/api/auth/callback/github`.

Commands use the tool versions pinned in `mise.toml`. Activate mise in your shell or prefix them with `mise exec --`.

```sh
just format       # Vite+ formatting and gofmt
just check        # formatting, lint, TypeScript, go vet
just test         # Cloudflare-runtime tests and Go race tests
just build        # web assets, Worker deployment dry run, bin/maven-r2
just contracts    # regenerate OpenAPI and Go client after contract changes
just ready        # all normal release checks
pnpm exec playwright install chromium
just interop      # isolated real Maven/Gradle publishing, resolution, and browser checks
```

`just interop` starts a temporary local Worker on port 8797, uses separate publishing/consuming Maven caches, seeds a test browser session, and removes its state and server afterward. Screenshots go to `.artifacts/`. It does not contact a deployed repository or test the external OAuth provider. Set `INTEROP_PORT` if necessary. Worker tests invoke Vitest directly for the Cloudflare pool; Vite+ handles frontend builds, formatting, and linting.

## Deploying an instance

1. Authenticate Wrangler and create a D1 database and a **private** R2 bucket:

    ```sh
    pnpm --filter @maven-r2/worker exec wrangler login
    pnpm --filter @maven-r2/worker exec wrangler d1 create maven-r2
    pnpm --filter @maven-r2/worker exec wrangler r2 bucket create maven-r2
    ```

2. Update `apps/worker/wrangler.jsonc`: replace the placeholder D1 ID, set `APP_URL` to the final HTTPS origin, configure your Worker domain, and set `ADMIN_GITHUB_IDS` to a comma-separated list of numeric GitHub IDs. Keep the R2 bucket private; all reads must pass through the Worker so repository permissions remain effective.

3. Create a GitHub OAuth app with callback `https://your-origin/api/auth/callback/github`. Set fresh deployment secrets interactively:

    ```sh
    pnpm --filter @maven-r2/worker exec wrangler secret put BETTER_AUTH_SECRET
    pnpm --filter @maven-r2/worker exec wrangler secret put BOOTSTRAP_TOKEN
    pnpm --filter @maven-r2/worker exec wrangler secret put GITHUB_CLIENT_ID
    pnpm --filter @maven-r2/worker exec wrangler secret put GITHUB_CLIENT_SECRET
    ```

    Use independent random secrets of at least 32 bytes for Better Auth and bootstrap. Numeric GitHub IDs, rather than changeable usernames, identify instance administrators.

4. Apply the database migration and deploy the Worker with its web assets:

    ```sh
    pnpm --filter @maven-r2/worker exec wrangler d1 migrations apply DB --remote
    just build
    pnpm --filter @maven-r2/worker deploy
    ```

5. Call `POST /api/bootstrap` on your deployed origin with the `x-bootstrap-token` header. Sign in with an administrator's GitHub identity, create the service accounts and scoped tokens you need, and revoke the bootstrap publisher. Delete the bootstrap secret afterward with `wrangler secret delete BOOTSTRAP_TOKEN` in the Worker workspace.

Back up D1 **and** R2 together: D1 contains the published-object references and authorization state. The hourly cron expires abandoned publications, prunes superseded snapshots, and collects unreferenced objects. An R2 lifecycle rule that aborts incomplete multipart uploads provides a backstop for uploads interrupted between R2 creation and recording the upload ID in D1; do not configure object expiration on published objects.

### Instance policy

| Setting                       | Meaning                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `INSTANCE_MODE=single`        | One default workspace; users can be invited into it. Account creation is disabled.                                       |
| `INSTANCE_MODE=multi`         | Multiple independent workspaces share an instance.                                                                       |
| `SIGNUP_MODE=closed`          | Only allowlisted administrators can create new login identities; existing users can still sign in.                       |
| `SIGNUP_MODE=invite`          | New users need an unexpired invitation matching their verified email, or an administrator identity.                      |
| `SIGNUP_MODE=open`            | Anyone supported by a configured identity provider may register. Registration alone does not grant workspace membership. |
| `ALLOW_ACCOUNT_CREATION=true` | In multi mode, signed-in users may create workspaces; otherwise only instance administrators can.                        |
| `MAX_FILE_BYTES`              | Instance upper bound for each artifact; repositories can set a lower limit. Default: 2 GiB.                              |
| `MAX_ACCOUNT_BYTES`           | Default workspace quota. Published files and reserved uploads both count. Default: 10 GiB.                               |

Optional OIDC uses `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`, with callback `/api/auth/callback/oidc`. GitHub remains the instance-admin identity source. Provider account linking is disabled. Invitation links are copied by an administrator and shared manually; no email delivery service is required.

An **account** is a workspace; a **user** is a login identity. Owners manage other owners, admins manage repositories and ordinary memberships, publishers publish, and readers download. Instance administrators can manage all workspaces, including suspension and quotas. A token's permissions are the intersection of its owner's current role and its scopes. Service accounts are readers or publishers, not administrators.

A scope such as `com/acme/sdk` matches that namespace and descendants, never `com/acme/sdkevil`. Empty prefixes grant the whole repository. Operations are `read`, `publish:release`, `publish:snapshot`, and `delete`. Private dependency resolution generally needs `read` on the artifact namespace, including its Maven metadata. Publishing-only tokens can submit metadata for their staged artifacts without reading other namespaces. Public visibility intentionally permits anonymous reads regardless of token scopes.

## Publishing

Build `bin/maven-r2` with `just build`, or use the platform binaries produced by the release workflow when a `v*` tag is pushed. No release tag is required for development.

Create a token in the console and save it under a named profile:

```sh
maven-r2 --server https://repo.example.com --profile work login
maven-r2 --profile work publish --repository acme/releases -- ./gradlew publish
maven-r2 --profile work publish --repository acme/snapshots -- mvn -s settings.xml deploy
```

The CLI launches a loopback-only proxy with a random per-run credential, starts the build, and commits after a successful exit. Configure publishing to use the injected `MAVEN_R2_URL`, `MAVEN_R2_USERNAME`, and `MAVEN_R2_PASSWORD`. The remote token is removed from the child's environment. The proxy spools at most four files concurrently to temporary files, checks their hashes, uploads resumable parts, and cleans up the spool files.

Gradle publishing configuration:

```kotlin
publishing {
    repositories {
        maven {
            url = uri(providers.environmentVariable("MAVEN_R2_URL").get())
            isAllowInsecureProtocol = true // This URL is the local loopback proxy.
            credentials {
                username = providers.environmentVariable("MAVEN_R2_USERNAME").get()
                password = providers.environmentVariable("MAVEN_R2_PASSWORD").get()
            }
        }
    }
}
```

The proxy answers each upload only after the file is staged remotely. Gradle's HTTP client gives up after 30 seconds by default, so set `systemProp.org.gradle.internal.http.socketTimeout` in `gradle.properties` to cover your largest artifact, as the Gradle example does. Maven's default timeout is long enough.

For Maven, point both `distributionManagement.repository` and `snapshotRepository` at `${env.MAVEN_R2_URL}`, using a server ID with credentials from those environment variables. Complete multi-module examples are in [`examples/gradle`](examples/gradle) and [`examples/maven`](examples/maven). The Maven example uses the Flatten Maven Plugin to resolve `${revision}` in published POM coordinates.

In CI, set `MAVEN_R2_SERVER` and `MAVEN_R2_TOKEN` as environment variables and run the same `publish` command. Use a service-account token scoped to the repository and namespace being built. Profiles live in the OS user configuration directory with owner-only file permissions on Unix; `MAVEN_R2_CONFIG` overrides the file location. HTTPS is required except for loopback development origins.

Failed builds and publications the server rejects during validation abort by default. `--keep-on-failure` preserves them for inspection. A finalization that fails for transient reasons, such as a network or server error, leaves the session open and prints its ID so the validated uploads can be retried:

```sh
maven-r2 session status SESSION_ID
maven-r2 session commit SESSION_ID
maven-r2 session abort SESSION_ID
```

`session begin --repository acme/releases` and `serve --session SESSION_ID --env-file local.env` support explicit sessions. Source that environment file with exported variables in the build shell; commit explicitly afterward. The file is removed when `serve` exits. `publish --session SESSION_ID -- COMMAND` can retry an existing build if each previously staged path still has identical content. Rebuilt artifacts with different bytes require a new session. Sessions expire after 24 hours.

## Downloading

Consumers point directly at:

```text
https://repo.example.com/maven/acme/releases
https://repo.example.com/maven/acme/snapshots
```

Public repositories need only the URL. For private repositories, use any Basic-auth username and a scoped read token as the password. The web console supplies dependency coordinates and repository snippets. No local proxy is needed for downloads. Configure dependency repositories separately from publishing destinations, including in CI. If the publishing build also downloads private dependencies, supply a separate read credential (for example `MAVEN_R2_READ_TOKEN`); the proxy deliberately removes `MAVEN_R2_TOKEN` from the build environment.

### Custom repository URLs

Set `vars.REPOSITORY_MAPPINGS` in `apps/worker/wrangler.jsonc` to map URLs to existing account/repository slugs. Origin-relative URLs resolve against `APP_URL`, so the default configuration serves the bootstrap repositories from the console origin:

```json
"REPOSITORY_MAPPINGS": [
    {
        "url": "/",
        "account": "default",
        "repository": "releases"
    },
    {
        "url": "/snapshots",
        "account": "default",
        "repository": "snapshots"
    }
]
```

With `APP_URL` set to `https://repo.example.com`, consumers of public repositories can then use:

```kotlin
repositories {
    maven("https://repo.example.com")
    maven("https://repo.example.com/snapshots")
}
```

Absolute URLs map repositories hosted on separate custom domains, such as `https://maven.chunkzero.com/snapshots`. Locally, `http://localhost:5173/` and `http://localhost:5173/snapshots/` serve the default repositories because Vite+ forwards them to the Worker without rewriting the host.

Mappings preserve repository visibility, token scopes, and R2 streaming. Bootstrap repositories are private until an administrator changes their visibility; private consumers still need read credentials. Existing `/maven/{account}/{repository}` URLs continue to work, and publishing still uses the account/repository pair through the CLI.

Mappings work in both instance modes. Each URL selects exactly one repository. To serve another account, configure another hostname or path with that account's slugs. Register each hostname as a [Worker custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) or Worker route pointing to this Worker; adding a mapping does not provision DNS or TLS. Keep the R2 bucket private.

Relative URLs start with a single slash. Absolute URLs must use HTTPS, except HTTP on `localhost`, `127.0.0.1`, or `[::1]` for local development. Matching uses the exact origin and the longest matching path prefix at a slash boundary, so `/snapshots` takes precedence over a root mapping. A missing artifact in that repository returns 404 without falling back to another repository. Trailing slashes are optional; duplicate URLs are rejected. `/api`, `/maven`, `/console`, `/health`, `/invite`, `/favicon.ico`, `/robots.txt`, and `/.well-known` are reserved, including their descendants. Nested mappings also reserve their prefixes in the parent mapping; artifacts shadowed by these prefixes remain available at the canonical `/maven/...` URL.

The console is served from `/` and routes with a URL hash, for example `/#/default/repositories`, so root mappings and console pages share the origin without ambiguity. Its assets stay under `/console/assets/`, and old `/console/...` bookmarks and `/invite` links redirect to the matching `/#/...` route. `APP_URL` is the console's origin; OAuth callback URLs stay under `/api/auth`. The console displays the first configured mapping for a repository in copyable URLs and dependency snippets, falling back to its canonical URL when no mapping exists. Browser download buttons use the console origin so session credentials work even when a mapping uses another hostname.

## Initial implementation boundaries

- GitHub/OIDC provider redirects and deployed Cloudflare behavior require deployment credentials to validate. Automated checks cover local Cloudflare bindings, Better Auth session validation, real Maven/Gradle interoperability, and browser management flows.
- Publication sessions are bounded to 500 uploaded files (including sidecars), 32 artifact IDs, 32 snapshot versions, and a bounded finalization transaction. Split larger builds into separate sessions. POMs and metadata are limited to 1 MiB; ordinary file limits are configurable. The 2 GiB default has not been load-tested on deployed Workers.
- Releases and timestamped snapshot files cannot change in place. An identical retry is accepted; adding new files to an existing release requires deleting and republishing the complete version. Non-timestamped snapshots are mutable. Signed repository metadata is rejected because the server regenerates metadata; artifact signatures are preserved but not cryptographically verified.
- Version deletion and retention remove references immediately and delay object deletion by an hour for in-flight readers. Quotas measure logical stored content and reservations, not temporary duplicate R2 storage or retained audit/session records.
- Console account listings are capped at 200 workspaces; publication and audit history show the latest 100 entries. File browsing uses pagination. Retention and garbage collection run in bounded batches and may take several hourly passes for a backlog.
- Upstream mirrors/proxy caches, virtual repositories, Maven Central promotion, webhooks, download analytics, bulk imports, and a browser OAuth device flow for the CLI are future work. The CLI currently logs in with a console-issued token.
