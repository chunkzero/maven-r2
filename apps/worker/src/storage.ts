import { createHash } from "node:crypto";
import type { Env } from "./env";
import { fail } from "./security";

export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_METADATA_SIZE = 1024 * 1024;
export const algorithms = ["md5", "sha1", "sha256", "sha512"] as const;
export type Checksums = Record<(typeof algorithms)[number], string>;
export async function digestStream(stream: ReadableStream<Uint8Array>, expectedSize?: number) {
    const digests = algorithms.map((algorithm) => createHash(algorithm));
    let size = 0;
    const reader = stream.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (expectedSize !== undefined && size > expectedSize) {
                await reader.cancel();
                fail(400, "Object size mismatch");
            }
            for (const digest of digests) digest.update(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (expectedSize !== undefined && size !== expectedSize) fail(400, "Object size mismatch");
    const checksums = Object.fromEntries(
        algorithms.map((algorithm, index) => [algorithm, digests[index]!.digest("hex")]),
    ) as Checksums;
    return { size, checksums };
}
export async function storeText(env: Env, accountId: string, text: string) {
    const bytes = new TextEncoder().encode(text);
    const { checksums } = await digestStream(new Blob([bytes]).stream());
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
