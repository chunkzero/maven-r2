import { createHash } from "node:crypto";
import type { Checksums } from "@maven-r2/contracts";
import type { Env } from "./env";
import { fail } from "./security";

export type { Checksums } from "@maven-r2/contracts";

export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_METADATA_SIZE = 1024 * 1024;
export async function storeText(env: Env, accountId: string, text: string) {
    const bytes = new TextEncoder().encode(text);
    const checksums = Object.fromEntries(
        ["md5", "sha1", "sha256", "sha512"].map((algorithm) => [
            algorithm,
            createHash(algorithm).update(bytes).digest("hex"),
        ]),
    ) as Checksums;
    const key = `objects/${accountId}/${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO garbage (object_key,not_before) VALUES (?,?)")
        .bind(key, Date.now() + 24 * 60 * 60 * 1000)
        .run();
    await env.BUCKET.put(key, bytes);
    return {
        object_key: key,
        size: bytes.byteLength,
        sha256: checksums.sha256,
        checksums: JSON.stringify(checksums),
    };
}
export async function readSmall(env: Env, key: string, max = MAX_METADATA_SIZE) {
    const object = await env.BUCKET.get(key);
    if (!object) fail(409, "Staged object is missing; upload it again");
    if (object.size > max) fail(413, "Metadata exceeds the size limit");
    return object.text();
}
