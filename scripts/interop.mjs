import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

// Isolated local D1/R2 and test sessions; never connects to a deployed instance.
const root = resolve(import.meta.dirname, ".."),
    temporary = await mkdtemp(join(tmpdir(), "maven-r2-interop-"));
const port = Number(process.env.INTEROP_PORT ?? 8797),
    origin = `http://127.0.0.1:${port}`;
const configPath = join(temporary, "wrangler.json"),
    state = join(temporary, "state");
const testConfig = JSON.parse(
    (await readFile(join(root, "apps/worker/test/wrangler.jsonc"), "utf8")).replace(
        /,\s*([}\]])/g,
        "$1",
    ),
);
testConfig.main = join(root, "apps/worker/src/index.ts");
testConfig.vars.APP_URL = origin;
testConfig.vars.REPOSITORY_MAPPINGS = [
    { url: origin, account: "test", repository: "releases" },
    { url: origin + "/snapshots", account: "test", repository: "snapshots" },
];
testConfig.d1_databases[0].migrations_dir = join(root, "apps/worker/migrations");
testConfig.assets = {
    directory: join(root, "apps/web/dist"),
    binding: "ASSETS",
    html_handling: "none",
    run_worker_first: ["/*", "!/console/assets/*"],
};
await writeFile(configPath, JSON.stringify(testConfig));
const wrangler = ["--filter", "@maven-r2/worker", "exec", "wrangler"];
let server,
    browser,
    logs = "";
async function run(command, args, env = process.env) {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
    return output;
}
async function sql(statement) {
    const path = join(temporary, "seed.sql");
    await writeFile(path, statement);
    await run("pnpm", [
        ...wrangler,
        "d1",
        "execute",
        "DB",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        state,
        "--file",
        path,
    ]);
}
async function json(path, options) {
    const response = await fetch(origin + path, options);
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
}
try {
    const probe = createServer();
    probe.listen(port, "127.0.0.1");
    await once(probe, "listening");
    await new Promise((resolve) => probe.close(resolve));
    await run("pnpm", [
        ...wrangler,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        state,
    ]);
    server = spawn(
        "pnpm",
        [
            ...wrangler,
            "dev",
            "--config",
            configPath,
            "--persist-to",
            state,
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
            "--inspector-port",
            "0",
        ],
        { cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout.on("data", (data) => (logs += data));
    server.stderr.on("data", (data) => (logs += data));
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            ready = (await fetch(origin + "/health")).ok;
        } catch {
            /* Startup is asynchronous. */
        }
        if (ready) break;
        if (server.exitCode !== null) throw new Error("Worker exited during startup");
        await delay(250);
    }
    assert.ok(ready, "Worker did not start");
    const bootstrap = await json("/api/bootstrap", {
        method: "POST",
        headers: { "x-bootstrap-token": testConfig.vars.BOOTSTRAP_TOKEN },
    });
    const env = {
        ...process.env,
        MAVEN_R2_SERVER: origin,
        MAVEN_R2_TOKEN: bootstrap.token,
        MAVEN_R2_CONFIG: join(temporary, "profiles.json"),
    };
    const cli = join(root, "bin/maven-r2");
    for (const [repo, version] of [
        ["releases", "1.0.0"],
        ["snapshots", "1.1.0-SNAPSHOT"],
    ]) {
        console.log(`Publishing ${version} with Gradle and Maven…`);
        await run(
            cli,
            [
                "publish",
                "--repository",
                `test/${repo}`,
                "--",
                "./examples/gradle/gradlew",
                "-p",
                "examples/gradle",
                "publish",
                `-PpublishVersion=${version}`,
                "--no-daemon",
            ],
            env,
        );
        await run(
            cli,
            [
                "publish",
                "--repository",
                `test/${repo}`,
                "--",
                "mvn",
                "-B",
                "-ntp",
                "-f",
                "examples/maven/pom.xml",
                "-s",
                "examples/maven/settings.xml",
                `-Drevision=${version}`,
                `-Dmaven.repo.local=${join(temporary, "m2-publish")}`,
                "deploy",
            ],
            env,
        );
    }
    for (const [repo, version] of [
        ["releases", "1.0.0"],
        ["snapshots", "1.1.0-SNAPSHOT"],
    ]) {
        console.log(`Resolving ${version} directly with Gradle and Maven…`);
        const url = repo === "releases" ? origin : origin + "/snapshots";
        await run(
            "./examples/gradle/gradlew",
            [
                "-p",
                "examples/gradle",
                ":consumer:verifyDownloads",
                `-PdownloadRepository=${url}`,
                `-PverifyVersion=${version}`,
                "--refresh-dependencies",
                "--no-daemon",
            ],
            env,
        );
        await run(
            "mvn",
            [
                "-B",
                "-ntp",
                "-f",
                "examples/consumer/pom.xml",
                "-s",
                "examples/maven/settings.xml",
                `-Dverify.version=${version}`,
                `-Dmaven.repo.local=${join(temporary, "m2-consume")}`,
                "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:resolve",
            ],
            {
                ...env,
                MAVEN_R2_DOWNLOAD_URL: url,
                MAVEN_R2_USERNAME: "maven-r2",
                MAVEN_R2_PASSWORD: bootstrap.token,
            },
        );
    }
    console.log("Checking the web console with real repository data…");
    const now = Date.now(),
        session = "browser-test-session";
    await sql(
        `INSERT INTO auth_users (id,name,email,email_verified,github_id,created_at,updated_at) VALUES ('browser','Alex Example','alex@example.com',1,'42',${now},${now}); INSERT INTO auth_sessions (id,token,user_id,expires_at,created_at,updated_at) VALUES ('browser','${session}','browser',${now + 3600000},${now},${now});`,
    );
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const signature = createHmac("sha256", testConfig.vars.BETTER_AUTH_SECRET)
        .update(session)
        .digest("base64");
    await context.addCookies([
        {
            name: "better-auth.session_token",
            value: encodeURIComponent(session + "." + signature),
            url: origin,
            httpOnly: true,
            sameSite: "Lax",
        },
    ]);
    const page = await context.newPage(),
        errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/console/test");
    await expect(page.getByRole("heading", { name: "Repositories", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Releases", exact: true })).toBeVisible();
    const screenshots = join(root, ".artifacts");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "repositories.png"), fullPage: true });
    await page.goto(
        origin + "/console/test/repositories/releases?prefix=com/example/mavenr2/core/1.0.0",
    );
    await expect(page.getByRole("button", { name: "core-1.0.0.pom", exact: true })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "repositories {" })).toContainText(
        'password = providers.environmentVariable("MAVEN_R2_READ_TOKEN").get()',
    );
    await expect(page.locator("pre").filter({ hasText: "repositories {" })).toContainText(
        `url = uri("${origin}")`,
    );
    await page.screenshot({ path: join(screenshots, "artifacts.png"), fullPage: true });
    await page.getByRole("button", { name: "core-1.0.0.pom", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("SHA-256");
    const detailDownload = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("link", { name: "Download", exact: true }).click();
    assert.equal((await detailDownload).suggestedFilename(), "core-1.0.0.pom");
    await page.getByRole("button", { name: "Close dialog" }).click();
    const rowDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download core-1.0.0.pom", exact: true }).click();
    assert.equal((await rowDownload).suggestedFilename(), "core-1.0.0.pom");

    await sql(`
        WITH RECURSIVE fixture(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM fixture WHERE n<501)
        INSERT INTO files (repository_id,path,object_key,size,sha256,checksums,publication_id,updated_at)
        SELECT repository_id,'zz/qa/1.0/qa-1.0-' || n || '.pom',object_key,size,sha256,checksums,publication_id,updated_at
        FROM files CROSS JOIN fixture WHERE path='com/example/mavenr2/core/1.0.0/core-1.0.0.pom';
    `);
    await page.goto(origin + "/console/test/repositories/releases");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page).toHaveURL(/after=/);
    await page.getByRole("searchbox", { name: "Search artifact paths" }).fill("core-1.0.0.pom");
    await expect(
        page.getByRole("button", {
            name: "com/example/mavenr2/core/1.0.0/core-1.0.0.pom",
            exact: true,
        }),
    ).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.has("after"), false);
    await page.goto(origin + "/console/test/tokens");
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Token name").fill("Browser verification");
    await dialog.getByLabel("Allowed namespaces or paths").fill("com/example/mavenr2");
    await dialog.getByRole("button", { name: "Create token", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Your token is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Revoke Browser verification" }).click();
    await page.getByRole("button", { name: "Revoke token", exact: true }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/console/test");
    await expect(page.getByRole("heading", { name: "Repositories", exact: true })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true });
    assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "Mobile page overflows horizontally",
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    const config = await json("/api/config");
    for (const provider of ["oidc", "github"]) {
        await page.route("**/api/config", (route) =>
            route.fulfill({
                json: {
                    ...config,
                    githubEnabled: provider === "github",
                    oidcEnabled: provider === "oidc",
                },
            }),
        );
        const endpoint = "/api/auth/sign-in/social";
        await page.route("**" + endpoint, (route) =>
            route.fulfill({ status: 503, json: { message: "Sign-in provider is unavailable." } }),
        );
        await page.reload();
        const signIn = page.waitForRequest(
            (request) => new URL(request.url()).pathname === endpoint,
        );
        await page.getByRole("button", { name: /Sign in/ }).click();
        assert.deepEqual((await signIn).postDataJSON(), {
            provider,
            callbackURL: page.url(),
        });
        await expect(page.getByRole("alert")).toHaveText("Sign-in provider is unavailable.");
        await expect(page.getByRole("button", { name: /Sign in/ })).toBeEnabled();
        await page.unroute("**/api/config");
        await page.unroute("**" + endpoint);
    }
    assert.deepEqual(errors, []);
    console.log(
        "Passed: four publications, four direct resolution builds, and browser management checks.",
    );
} catch (error) {
    console.error(logs);
    throw error;
} finally {
    await browser?.close();
    if (server && server.exitCode === null) {
        if (process.platform === "win32") server.kill();
        else process.kill(-server.pid, "SIGTERM");
        await Promise.race([once(server, "exit"), delay(5000)]);
    }
    await rm(temporary, { recursive: true, force: true });
}
