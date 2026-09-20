# Maven R2

A Maven repository on Cloudflare Workers and R2, with a Go publishing proxy and a web console.

Maven and Gradle publish through the local proxy. Consumers download directly from the hosted repository. Publication sessions keep incomplete releases private until the build succeeds.

## Development

Install [mise](https://mise.jdx.dev/), then run `mise install` and `mise exec -- just setup`.

The TypeScript workspace uses project-local [Vite+](https://viteplus.dev/), pnpm, Hono, Better Auth, and React. Go produces a standalone publishing client. `just --list` lists development commands.

Deployment and publishing instructions are included as the components are implemented.
