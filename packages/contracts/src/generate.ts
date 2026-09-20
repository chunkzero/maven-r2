import { OpenAPIHono } from "@hono/zod-openapi";
import { writeFileSync, mkdirSync } from "node:fs";
import { clientRoutes } from "./index";

const app = new OpenAPIHono();
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
});
for (const route of clientRoutes) app.openAPIRegistry.registerPath(route);
const document = app.getOpenAPIDocument({
    openapi: "3.0.3",
    info: { title: "Maven R2 publishing API", version: "1.0.0" },
});
mkdirSync("generated", { recursive: true });
writeFileSync("generated/openapi.json", JSON.stringify(document, null, 2) + "\n");
