import { createRoute, z } from "@hono/zod-openapi";
import {
    slug,
    checksumsSchema,
    publicationSchema as publication,
    uploadSchema as upload,
    errorSchema as error,
} from "./schemas";
export * from "./schemas";
const publicationSchema = publication.openapi("Publication");
const uploadSchema = upload.openapi("Upload");
const errorSchema = error.openapi("Error");

const json = <T extends z.ZodType>(schema: T, description = "Success") => ({
    description,
    content: { "application/json": { schema } },
});
const errors = {
    400: json(errorSchema, "Invalid request"),
    401: json(errorSchema, "Authentication required"),
    403: json(errorSchema, "Forbidden"),
    404: json(errorSchema, "Not found"),
    409: json(errorSchema, "Conflict"),
    413: json(errorSchema, "Quota or size exceeded"),
};
const security = [{ bearerAuth: [] }];
const sessionParam = z.object({ session: z.string() });
const uploadParam = sessionParam.extend({ upload: z.string() });
export const createSessionRoute = createRoute({
    method: "post",
    path: "/api/publications",
    operationId: "createPublication",
    security,
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z
                        .object({
                            account: slug,
                            repository: slug,
                            label: z.string().max(200).default(""),
                        })
                        .openapi("CreatePublication"),
                },
            },
        },
    },
    responses: { 201: json(publicationSchema.openapi("Publication")), ...errors },
});
export const getSessionRoute = createRoute({
    method: "get",
    path: "/api/publications/{session}",
    operationId: "getPublication",
    security,
    request: { params: sessionParam },
    responses: { 200: json(publicationSchema), ...errors },
});
export const initUploadRoute = createRoute({
    method: "post",
    path: "/api/publications/{session}/uploads",
    operationId: "createUpload",
    security,
    request: {
        params: sessionParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z
                        .object({
                            path: z.string().min(1).max(1024),
                            size: z.number().int().min(0),
                            checksums: checksumsSchema.openapi("Checksums"),
                        })
                        .openapi("CreateUpload"),
                },
            },
        },
    },
    responses: { 200: json(uploadSchema), ...errors },
});
export const completeUploadRoute = createRoute({
    method: "post",
    path: "/api/publications/{session}/uploads/{upload}/complete",
    operationId: "completeUpload",
    security,
    request: { params: uploadParam },
    responses: { 200: json(uploadSchema), ...errors },
});
export const commitSessionRoute = createRoute({
    method: "post",
    path: "/api/publications/{session}/commit",
    operationId: "commitPublication",
    security,
    request: { params: sessionParam },
    responses: { 200: json(publicationSchema), ...errors },
});
export const abortSessionRoute = createRoute({
    method: "delete",
    path: "/api/publications/{session}",
    operationId: "abortPublication",
    security,
    request: { params: sessionParam },
    responses: { 200: json(publicationSchema), ...errors },
});
export const clientRoutes = [
    createSessionRoute,
    getSessionRoute,
    initUploadRoute,
    completeUploadRoute,
    commitSessionRoute,
    abortSessionRoute,
] as const;
