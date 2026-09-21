# Maven R2

A Maven repository backed by Cloudflare R2, with a Go publishing client and a web console. It supports public and private repositories, releases and snapshots, and scoped access tokens.

**Publish through the local proxy. Download directly from the hosted repository.** The CLI computes checksums and uploads artifacts through a Cloudflare Worker. A publication becomes visible only after the build succeeds and the service validates it. Maven and Gradle never receive R2 credentials.

> [!WARNING]
> Experimental and heavily vibe-coded. It works for our current use, but there are rough edges and it has not had a security audit. Expect bugs and breaking changes to the API, CLI, and storage schema. Keep backups of both D1 and R2. Don't make this the only copy of artifacts you care about.

## Publishing

Build the CLI from this checkout with Go:

```sh
go build -o bin/maven-r2 ./cli
```

Put `bin/maven-r2` on your `PATH`, or use `./bin/maven-r2` in the commands below. Use matching CLI and Worker versions.

Create a publishing token in the web console, then save it in a local profile:

```sh
maven-r2 --server https://repo.example.com --profile work login
```

Configure Gradle to publish through the local proxy:

```kotlin
publishing {
    repositories {
        maven {
            url = uri(providers.environmentVariable("MAVEN_R2_URL").get())
            isAllowInsecureProtocol = true // The proxy listens on loopback only.
            credentials {
                username = providers.environmentVariable("MAVEN_R2_USERNAME").get()
                password = providers.environmentVariable("MAVEN_R2_PASSWORD").get()
            }
        }
    }
}
```

Run the build through the CLI, using your workspace and repository slugs:

```sh
maven-r2 --profile work publish --repository default/releases -- ./gradlew publish
maven-r2 --profile work publish --repository default/snapshots -- mvn -s settings.xml deploy
```

The CLI starts the proxy, supplies its URL and temporary credentials to the build, and commits the publication when the command succeeds. Failed builds abort the publication.

For Maven, point both `distributionManagement.repository` and `snapshotRepository` at `${env.MAVEN_R2_URL}`. Their server credentials come from `MAVEN_R2_USERNAME` and `MAVEN_R2_PASSWORD`. Working examples are in [`examples/gradle`](examples/gradle) and [`examples/maven`](examples/maven).

Uploads are staged remotely before the proxy responds. For large artifacts, increase `systemProp.org.gradle.internal.http.socketTimeout` in `gradle.properties`, as the Gradle example does.

### CI

Set `MAVEN_R2_SERVER` and `MAVEN_R2_TOKEN`, then run the same `publish` command without a profile. Use a service-account token restricted to the repository, artifact path prefix, and publishing operations the project needs.

If the build also downloads private dependencies, give it a separate read token. The CLI removes `MAVEN_R2_TOKEN` from the build's environment.

### Recovering a publication

If finalization fails for a transient reason, the CLI leaves the session open and prints its ID. Retry the commit or discard it:

```sh
maven-r2 --profile work session status SESSION_ID
maven-r2 --profile work session commit SESSION_ID
maven-r2 --profile work session abort SESSION_ID
```

Sessions expire after 24 hours. Use `--keep-on-failure` to preserve a failed build's publication for inspection.

## Downloading

Consumers use the hosted repository directly. They do not need the CLI.

The default URL mappings expose releases at the origin and snapshots at `/snapshots`:

```kotlin
repositories {
    maven("https://repo.example.com")
    maven("https://repo.example.com/snapshots")
}
```

Repositories start **private**. For private downloads, use Basic authentication with any username and a scoped read token as the password. Public repositories need no credentials. The console supplies repository URLs and dependency snippets.

You can change `vars.REPOSITORY_MAPPINGS` in your deployment configuration. URLs of the form `/maven/{account}/{repository}` also work regardless of the mappings.

<details>
<summary>Custom repository URLs</summary>

Each mapping selects an existing workspace and repository. Relative URLs resolve against `APP_URL`:

```json
"REPOSITORY_MAPPINGS": [
    { "url": "/", "account": "default", "repository": "releases" },
    { "url": "/snapshots", "account": "default", "repository": "snapshots" }
]
```

Absolute HTTPS URLs can use other hostnames. Register those hostnames as Worker custom domains or routes separately. Mappings do not provision DNS or TLS, and they do not change repository visibility.

The longest matching path prefix wins. Missing artifacts do not fall back to another repository. Application paths such as `/api`, `/console`, and `/maven` are reserved.

</details>

## Deploying an instance

The service needs a Cloudflare Worker, a D1 database, a private R2 bucket, and a GitHub OAuth app. D1 stores repository metadata and permissions. R2 stores artifact contents.

Keep production configuration in a private deployment repository that pins a commit of this project. Generate an ignored `apps/worker/wrangler.production.jsonc` beside the supplied `wrangler.jsonc`, using it as a template. Exclude the generated file through the source checkout's `.git/info/exclude`. Keeping the files together preserves the relative source, asset, and migration paths. The commands below assume that generated configuration exists and dependencies are installed.

1. Authenticate Wrangler and create the resources:

    ```sh
    pnpm --filter @maven-r2/worker exec wrangler login
    pnpm --filter @maven-r2/worker exec wrangler d1 create maven-r2
    pnpm --filter @maven-r2/worker exec wrangler r2 bucket create maven-r2
    ```

2. In your production configuration, set the Cloudflare account ID, D1 ID, bucket name, Worker domain, `APP_URL`, and `ADMIN_GITHUB_IDS`. Administrator IDs are numeric GitHub user IDs. Keep the R2 bucket private with no public domain or r2.dev endpoint.

3. Create a GitHub OAuth app with callback `https://your-origin/api/auth/callback/github`. Set these Worker secrets using `pnpm --filter @maven-r2/worker exec wrangler secret put NAME --config wrangler.production.jsonc`:

    - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the OAuth app.
    - `BETTER_AUTH_SECRET` and `BOOTSTRAP_TOKEN`, each independently generated with at least 32 random bytes.

4. Build, migrate, and deploy:

    ```sh
    pnpm --filter @maven-r2/web build
    pnpm --filter @maven-r2/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
    pnpm --filter @maven-r2/worker exec wrangler deploy --config wrangler.production.jsonc
    ```

5. Call `POST /api/bootstrap` with the `x-bootstrap-token` header. This creates the default workspace, private release and snapshot repositories, and a temporary publisher token. Sign in through GitHub, create scoped tokens for your projects, and revoke the bootstrap publisher. Delete `BOOTSTRAP_TOKEN` with `wrangler secret delete`, using the same production configuration.

The default signup policy is closed. Only configured administrators can register. `SIGNUP_MODE=invite` allows registration with an invitation, and `SIGNUP_MODE=open` allows registration without one. Registration alone does not grant workspace access.

For **Workers Free**, remove `limits.cpu_ms` from the generated configuration. Computing checksums in the CLI does not guarantee that every workload fits the free tier. Check the [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) against your workload.

Back up **D1 and R2 together**. Do not add an R2 object-expiration rule for published artifacts. The Worker's scheduled cleanup handles expired publications, snapshot retention, and unreferenced objects.

## Development

Install [mise](https://mise.jdx.dev/), then run:

```sh
mise trust
mise install
mise exec -- just setup
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
mise exec -- pnpm db:migrate
mise exec -- just dev
```

Open http://localhost:5173. Wrangler emulates the Cloudflare resources locally. Initialize the instance once:

```sh
curl --fail-with-body -X POST http://localhost:5173/api/bootstrap \
  -H 'x-bootstrap-token: local-bootstrap-only-replace-before-deploy'
```

To sign into the console, configure a development GitHub OAuth app in `.dev.vars` and set `ADMIN_GITHUB_IDS` in the local Wrangler configuration. The callback is `http://localhost:5173/api/auth/callback/github`. The example secrets are for local development only.

Use `mise exec --` before commands if mise is not active in your shell:

```sh
just format       # Format TypeScript and Go
just check        # Formatting, lint, type checks, and go vet
just test         # Worker and Go tests
just build        # Build the web app, Worker, and CLI
just contracts    # Regenerate API clients after contract changes
just ready        # Check, test, and build
```

For Maven/Gradle interoperability and browser tests, install Chromium with `pnpm exec playwright install chromium`, then run `just interop`.

## Known limitations

- The CLI supplies MD5, SHA-1, SHA-256, and SHA-512 checksums. R2 verifies SHA-256 for single-part uploads. For multipart uploads, the service checks completeness and stored size but trusts the publisher's hashes. Supplied checksum sidecars must match those hashes.
- Releases and timestamped snapshots are immutable. Identical retries are accepted, but changing an existing release requires deleting and republishing the complete version. Artifact signatures are stored without cryptographic verification.
- A publication can contain at most 500 files including sidecars, 32 artifact IDs, and 32 snapshot versions. POMs and metadata are limited to 1 MiB. The default per-file limit is 2 GiB, which has not been load-tested on deployed Workers.
- Storage quotas count published and reserved bytes, not temporary duplicate objects or audit history. Deletion removes references immediately, but object cleanup is delayed by at least an hour.
- Upstream repository mirroring and Maven Central promotion are not implemented.

## License

[MIT](LICENSE).
