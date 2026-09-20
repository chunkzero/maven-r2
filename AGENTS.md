# Maven R2

A Maven repository service backed by Cloudflare R2, with a local publishing proxy and web console.

## General guidelines

- Do not edit AGENTS.md or CLAUDE.md unless explicitly asked.
- Keep changes simple, typed, and modular. Prefer maintained libraries for standard protocols.
- Do not revert unrelated changes or perform destructive operations without authorization.
- Check for existing project servers before starting another; stop resources you start when finished.
- Use focused tests during development. Run `just ready` before publishing substantial changes.

## Tooling

- Run `mise install` for the pinned Node, pnpm, Go, Java, Gradle, and just versions.
- Use `mise exec -- <command>` if mise is not active in your shell.
- Use pnpm for the TypeScript workspace; run `pnpm install` when dependencies change.
- Vite+ is project-local. Use `pnpm format`, `pnpm format:check`, and `pnpm lint`.
- Run `pnpm typecheck`, `pnpm test:worker`, or `go test ./internal/<package>` as appropriate.
- Use `just contracts` after changing the publishing API. Never manually edit generated clients.
- Use the Gradle wrapper in examples. Avoid editing dependency caches and build output.

## Code style

- Prefer inferred TypeScript types and narrow package exports.
- Keep authorization in the hosted service; the local client is not a trust boundary.
- Use comments sparingly, scoped to current behavior.
- Test important behavior and failure cases without duplicating implementation details.
- Keep secrets, tokens, and private artifact contents out of logs and fixtures.

## Git

- Use Conventional Commits and keep commits focused on logical changes.
- CI is the source of truth; do not add pre-commit hooks.

## Glossary

- Account: a workspace owning repositories and memberships, distinct from a login identity.
- Repository: a public or private Maven endpoint with a release/snapshot policy.
- Publication: a session of staged files made visible together after successful validation.
- Scope: repository, path boundary, and operation restrictions on a service token.
