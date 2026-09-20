import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";
import { z } from "zod";

export const authClient = createAuthClient();
export async function api<T extends z.ZodType>(
    path: string,
    schema: T,
    method = "GET",
    body?: unknown,
): Promise<z.output<T>> {
    const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await response.json();
    if (!response.ok)
        throw new Error(
            z.object({ error: z.string() }).safeParse(data).data?.error ?? "Request failed",
        );
    return schema.parse(data);
}
export function useApi<T extends z.ZodType>(path: string, schema: T, enabled = true) {
    return useQuery({ queryKey: [path], queryFn: () => api(path, schema), enabled });
}
export function useAction<T>(fn: (data: T) => Promise<unknown>, success?: () => void) {
    const cache = useQueryClient();
    return useMutation({
        mutationFn: fn,
        onSuccess: async () => {
            await cache.invalidateQueries();
            success?.();
        },
    });
}
export const ok = z.object({ ok: z.boolean() });
