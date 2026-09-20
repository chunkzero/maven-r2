import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { FileRow, UploadRow } from "./db";
import { canonicalPath, fail } from "./security";

const plugin = z.object({
    name: z.string().optional(),
    prefix: z.string(),
    artifactId: z.string(),
});
const snapshotVersion = z.object({
    extension: z.string(),
    classifier: z.string().optional(),
    value: z.string(),
    updated: z.string(),
});
const metadata = z.object({
    groupId: z.string().optional(),
    artifactId: z.string().optional(),
    version: z.string().optional(),
    plugins: z.object({ plugin: z.array(plugin) }).optional(),
    versioning: z
        .object({
            latest: z.string().optional(),
            release: z.string().optional(),
            lastUpdated: z.string().optional(),
            versions: z.object({ version: z.array(z.string()) }).optional(),
            snapshot: z
                .object({
                    timestamp: z.string().optional(),
                    buildNumber: z.string().optional(),
                    localCopy: z.string().optional(),
                })
                .optional(),
            snapshotVersions: z.object({ snapshotVersion: z.array(snapshotVersion) }).optional(),
        })
        .optional(),
});
export type Metadata = z.infer<typeof metadata>;
const parser = new XMLParser({
    parseTagValue: false,
    ignoreAttributes: true,
    processEntities: false,
    isArray: (_name, path) =>
        [
            "metadata.plugins.plugin",
            "metadata.versioning.versions.version",
            "metadata.versioning.snapshotVersions.snapshotVersion",
        ].includes(String(path)),
});
const builder = new XMLBuilder({ format: true, indentBy: "  ", suppressEmptyNode: true });
export function parseXml(text: string): unknown {
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
        fail(400, "Invalid or unsafe XML");
    return parser.parse(text) as unknown;
}
export function parseMetadata(text: string): Metadata {
    const result = z.object({ metadata }).safeParse(parseXml(text));
    if (!result.success) fail(400, "Invalid Maven metadata");
    return result.data.metadata;
}
export function xmlMetadata(data: Metadata) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build({ metadata: data });
}
export function isMetadata(path: string) {
    return path.endsWith("/maven-metadata.xml");
}
export function checksumBase(path: string) {
    const match = /\.(md5|sha1|sha256|sha512)$/.exec(path);
    return match
        ? {
              path: path.slice(0, -match[0].length),
              algorithm: match[1] as "md5" | "sha1" | "sha256" | "sha512",
          }
        : null;
}
export function coordinates(path: string) {
    if (isMetadata(path) || checksumBase(path) || path.endsWith(".asc")) return null;
    const parts = path.split("/");
    if (parts.length < 4) fail(400, "Artifacts must use the Maven repository layout");
    const filename = parts.pop()!;
    const version = parts.pop()!;
    const artifactId = parts.pop()!;
    const groupPath = parts.join("/");
    const snapshot = version.endsWith("-SNAPSHOT");
    const base = snapshot ? version.slice(0, -9) : version;
    const expected = artifactId + "-" + version;
    let value = version;
    let rest = "";
    let timestamp: string | undefined;
    let buildNumber: string | undefined;
    if (filename.startsWith(expected + ".") || filename.startsWith(expected + "-"))
        rest = filename.slice(expected.length);
    else if (snapshot && filename.startsWith(artifactId + "-" + base + "-")) {
        const match = /^(\d{8}\.\d{6})-(\d+)([.-].+)$/.exec(
            filename.slice(artifactId.length + base.length + 2),
        );
        if (!match) fail(400, "Invalid snapshot filename");
        timestamp = match[1]!;
        buildNumber = match[2]!;
        value = base + "-" + timestamp + "-" + buildNumber;
        rest = match[3]!;
    } else fail(400, "Artifact filename does not match its coordinates");
    const dot = rest.indexOf(".");
    if (dot < 0) fail(400, "Artifact extension required");
    const classifier = rest.startsWith("-") ? rest.slice(1, dot) : undefined;
    const extension = rest.slice(dot + 1);
    if (!extension) fail(400, "Artifact extension required");
    return {
        groupPath,
        groupId: groupPath.replaceAll("/", "."),
        artifactId,
        version,
        snapshot,
        value,
        timestamp,
        buildNumber,
        classifier,
        extension,
        artifactPath: groupPath + "/" + artifactId,
        versionPath: groupPath + "/" + artifactId + "/" + version,
    };
}
export function publicationAction(path: string) {
    const base = checksumBase(path)?.path ?? path;
    if (isMetadata(base)) return null;
    const coordinate = coordinates(base.endsWith(".asc") ? base.slice(0, -4) : base);
    return coordinate?.snapshot ? ("publish:snapshot" as const) : ("publish:release" as const);
}
export function validatePom(text: string, path: string) {
    const project = z
        .object({
            project: z.object({
                groupId: z.string().optional(),
                artifactId: z.string(),
                version: z.string().optional(),
                parent: z.object({ groupId: z.string(), version: z.string() }).optional(),
            }),
        })
        .safeParse(parseXml(text));
    if (!project.success) fail(400, "Invalid POM");
    const p = project.data.project,
        c = coordinates(path)!;
    if (
        (p.groupId ?? p.parent?.groupId) !== c.groupId ||
        p.artifactId !== c.artifactId ||
        (p.version ?? p.parent?.version) !== c.version
    )
        fail(400, "POM coordinates do not match the repository path");
}
const stamp = (time: number) => new Date(time).toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function artifactMetadata(
    path: string,
    files: FileRow[],
    existing: Metadata = {},
): Metadata {
    const parent = path.slice(0, -"/maven-metadata.xml".length);
    const matching = files
        .map((file) => ({ file, c: coordinates(file.path) }))
        .filter((item) => item.c?.artifactPath === parent);
    const versions = new Map<string, number>();
    for (const { file, c } of matching)
        if (c) versions.set(c.version, Math.max(versions.get(c.version) ?? 0, file.updated_at));
    const ordered = [...versions]
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .map(([version]) => version);
    const c = matching[0]?.c;
    if (!c) return { ...existing, versioning: undefined };
    return {
        ...existing,
        groupId: c.groupId,
        artifactId: c.artifactId,
        versioning: {
            versions: { version: ordered },
            latest: ordered.at(-1),
            release: ordered.filter((version) => !version.endsWith("-SNAPSHOT")).at(-1),
            lastUpdated: stamp(Math.max(...matching.map((item) => item.file.updated_at))),
        },
    };
}
export function snapshotMetadata(path: string, files: FileRow[]): Metadata {
    const parent = path.slice(0, -"/maven-metadata.xml".length);
    const matches = files
        .map((file) => ({ file, c: coordinates(file.path) }))
        .filter((item) => item.c?.versionPath === parent)
        .sort(
            (a, b) =>
                a.file.updated_at - b.file.updated_at || a.file.path.localeCompare(b.file.path),
        );
    const c = matches.at(-1)?.c;
    if (!c) return {};
    const latest = new Map<string, z.infer<typeof snapshotVersion>>();
    for (const item of matches)
        if (item.c)
            latest.set(`${item.c.extension}:${item.c.classifier ?? ""}`, {
                extension: item.c.extension,
                classifier: item.c.classifier,
                value: item.c.value,
                updated: stamp(item.file.updated_at),
            });
    return {
        groupId: c.groupId,
        artifactId: c.artifactId,
        version: c.version,
        versioning: {
            snapshot: c.timestamp
                ? { timestamp: c.timestamp, buildNumber: c.buildNumber }
                : { localCopy: "true" },
            lastUpdated: stamp(matches.at(-1)!.file.updated_at),
            snapshotVersions: { snapshotVersion: [...latest.values()] },
        },
    };
}
export function mergePlugins(
    path: string,
    incoming: Metadata,
    existing: Metadata,
    uploads: UploadRow[],
): Metadata {
    const groupPath = path.slice(0, -"/maven-metadata.xml".length);
    const allowed = new Set(
        uploads
            .map((upload) => coordinates(upload.path))
            .filter((c) => c?.groupPath === groupPath)
            .map((c) => c!.artifactId),
    );
    const entries = new Map((existing.plugins?.plugin ?? []).map((item) => [item.prefix, item]));
    for (const item of incoming.plugins?.plugin ?? []) {
        canonicalPath(item.artifactId);
        canonicalPath(item.prefix);
        if (!allowed.has(item.artifactId)) continue;
        const previous = entries.get(item.prefix);
        if (previous && previous.artifactId !== item.artifactId)
            fail(409, "Plugin prefix is already assigned to another artifact");
        entries.set(item.prefix, item);
    }
    return { ...existing, plugins: entries.size ? { plugin: [...entries.values()] } : undefined };
}
