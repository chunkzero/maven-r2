import { useDeferredValue, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Download, File, Folder } from "lucide-react";
import { z } from "zod";
import {
    fileSchema,
    publicationSchema,
    repositorySchema,
    type Repository,
} from "@maven-r2/contracts/schemas";
import { api, ok, useAction, useApi } from "./api";
import { useWorkspace } from "./app";
import {
    Badge,
    bytes,
    Code,
    Confirm,
    date,
    Empty,
    ErrorNotice,
    Field,
    Loading,
    Modal,
    PageHeader,
} from "./components";

export function Repositories() {
    const { account } = useWorkspace(),
        repos = useApi(`/api/accounts/${account.slug}/repositories`, z.array(repositorySchema));
    const [creating, setCreating] = useState(false);
    const admin = account.role === "owner" || account.role === "admin";
    return (
        <>
            <PageHeader title="Repositories">
                {admin && (
                    <button className="button primary" onClick={() => setCreating(true)}>
                        New repository
                    </button>
                )}
            </PageHeader>
            {account.role && (
                <p className="muted">
                    {bytes(account.usedBytes)} stored · {bytes(account.reservedBytes)} staged ·{" "}
                    {bytes(account.maxBytes)} quota
                </p>
            )}
            <ErrorNotice error={repos.error} />
            {repos.isPending ? (
                <Loading />
            ) : repos.data?.length ? (
                <div className="scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>Repository</th>
                                <th>Visibility</th>
                                <th>Policy</th>
                                <th>Snapshot retention</th>
                            </tr>
                        </thead>
                        <tbody>
                            {repos.data.map((repo) => (
                                <tr key={repo.id}>
                                    <td>
                                        <Link to={`repositories/${repo.slug}`}>
                                            <strong>{repo.name}</strong>{" "}
                                            <span className="mono muted">
                                                {account.slug}/{repo.slug}
                                            </span>
                                        </Link>
                                    </td>
                                    <td>{repo.visibility}</td>
                                    <td>{repo.policy}</td>
                                    <td>
                                        {repo.retentionDays
                                            ? `${repo.retentionDays} days`
                                            : "Keep all"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <Empty>No repositories yet.</Empty>
            )}
            {creating && <RepositoryForm close={() => setCreating(false)} />}
        </>
    );
}

function RepositoryForm({ close, repository }: { close: () => void; repository?: Repository }) {
    const { account } = useWorkspace();
    const [name, setName] = useState(repository?.name ?? ""),
        [slug, setSlug] = useState(repository?.slug ?? ""),
        [visibility, setVisibility] = useState(repository?.visibility ?? "private"),
        [policy, setPolicy] = useState(repository?.policy ?? "releases"),
        [limit, setLimit] = useState((repository?.maxFileBytes ?? 2 ** 31) / 2 ** 20),
        [retention, setRetention] = useState(repository?.retentionDays ?? 0);
    const save = useAction(
        () =>
            api(
                `/api/accounts/${account.slug}/repositories${repository ? "/" + repository.slug : ""}`,
                repositorySchema,
                repository ? "PATCH" : "POST",
                {
                    ...(repository ? {} : { slug }),
                    name,
                    visibility,
                    policy,
                    maxFileBytes: limit * 2 ** 20,
                    retentionDays: retention,
                },
            ),
        close,
    );
    return (
        <Modal title={repository ? "Repository settings" : "Create a repository"} onClose={close}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate();
                }}
            >
                <Field label="Name">
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        maxLength={100}
                    />
                </Field>
                {!repository && (
                    <Field label="URL slug" hint="Lowercase letters, numbers, and hyphens.">
                        <input
                            value={slug}
                            onChange={(e) => setSlug(e.target.value)}
                            required
                            pattern="[a-z0-9][a-z0-9-]{0,62}"
                        />
                    </Field>
                )}
                <div className="form-row">
                    <Field label="Visibility">
                        <select
                            value={visibility}
                            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                        >
                            <option value="private">Private</option>
                            <option value="public">Public</option>
                        </select>
                    </Field>
                    <Field label="Version policy">
                        <select
                            value={policy}
                            onChange={(e) => setPolicy(e.target.value as typeof policy)}
                        >
                            <option value="releases">Releases</option>
                            <option value="snapshots">Snapshots</option>
                            <option value="mixed">Releases and snapshots</option>
                        </select>
                    </Field>
                </div>
                <div className="form-row">
                    <Field label="Maximum artifact size (MiB)">
                        <input
                            type="number"
                            value={limit}
                            onChange={(e) => setLimit(Number(e.target.value))}
                            min={1}
                            max={2048}
                            required
                        />
                    </Field>
                    <Field label="Snapshot retention (days)" hint="0 keeps every snapshot.">
                        <input
                            type="number"
                            value={retention}
                            onChange={(e) => setRetention(Number(e.target.value))}
                            min={0}
                            max={3650}
                            required
                        />
                    </Field>
                </div>
                <ErrorNotice error={save.error} />
                <div className="form-footer">
                    <button type="button" className="button" onClick={close}>
                        Cancel
                    </button>
                    <button className="button primary" disabled={save.isPending}>
                        {repository ? "Save changes" : "Create repository"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

type ArtifactFile = z.infer<typeof fileSchema>;
const fileList = z.object({ files: z.array(fileSchema), next: z.string().nullable() });
const encode = encodeURIComponent;

export function RepositoryBrowser() {
    const { account } = useWorkspace(),
        { repository: slug = "" } = useParams(),
        [params, setParams] = useSearchParams();
    const prefix = params.get("prefix") ?? "",
        after = params.get("after") ?? "";
    const [search, setSearch] = useState(""),
        query = useDeferredValue(search.trim().replaceAll(":", "/"));
    const base = `/api/accounts/${account.slug}/repositories/${slug}`;
    const repos = useApi(`/api/accounts/${account.slug}/repositories`, z.array(repositorySchema));
    const repo = repos.data?.find((repo) => repo.slug === slug);
    const files = useApi(
        `${base}/files?prefix=${encode(prefix)}&q=${encode(query)}&after=${encode(after)}`,
        fileList,
    );
    const publications = useApi(`${base}/publications`, z.array(publicationSchema), !!account.role);
    const [settings, setSettings] = useState(false),
        [selected, setSelected] = useState<ArtifactFile | null>(null),
        [deleting, setDeleting] = useState(false),
        [aborting, setAborting] = useState<string | null>(null);
    const admin = account.role === "owner" || account.role === "admin";
    const endpoint = `${location.origin}/maven/${account.slug}/${slug}`;
    const parts = prefix.split("/").filter(Boolean);
    const go = (path: string) => {
        setParams(path ? { prefix: path } : {});
        setSearch("");
    };
    const remove = useAction(
        () => api(base + "/delete-version", ok, "POST", { path: prefix }),
        () => {
            setDeleting(false);
            go(parts.slice(0, -1).join("/"));
        },
    );
    const abort = useAction(
        () => api(`${base}/publications/${aborting}/abort`, publicationSchema, "POST"),
        () => setAborting(null),
    );

    const rows = new Map<string, { name: string; folder: boolean; file?: ArtifactFile }>();
    for (const file of files.data?.files ?? []) {
        const relative = prefix ? file.path.slice(prefix.length + 1) : file.path;
        const name = query ? relative : relative.split("/")[0]!;
        const folder = !query && relative.includes("/");
        rows.set(name, { name, folder, file: folder ? undefined : file });
    }
    const sorted = [...rows.values()].sort(
        (a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name),
    );
    const pom = [...rows.values()].find((row) => row.file?.path.endsWith(".pom"))?.file;
    const gav = !query && pom ? pom.path.split("/") : null;
    const coordinate =
        gav && gav.length >= 4 ? `${gav.slice(0, -3).join(".")}:${gav.at(-3)}:${gav.at(-2)}` : null;
    const snippet = coordinate
        ? `repositories {\n    maven { url = uri("${endpoint}") }\n}\ndependencies {\n    implementation("${coordinate}")\n}`
        : `repositories {\n    maven { url = uri("${endpoint}") }\n}`;

    return (
        <>
            <PageHeader
                title={
                    <>
                        <Link to={`/${account.slug}`}>Repositories</Link> / {repo?.name ?? slug}
                    </>
                }
            >
                {admin && repo && (
                    <button className="button" onClick={() => setSettings(true)}>
                        Settings
                    </button>
                )}
            </PageHeader>
            {repo && (
                <p className="muted">
                    {repo.visibility} · {repo.policy} · files up to {bytes(repo.maxFileBytes)} ·{" "}
                    {repo.retentionDays
                        ? `snapshots kept ${repo.retentionDays} days`
                        : "all snapshots kept"}
                </p>
            )}
            <Code>{endpoint}</Code>
            <section>
                <div className="toolbar">
                    <nav className="crumbs" aria-label="Path">
                        <button onClick={() => go("")}>{slug}</button>
                        {parts.map((part, index) => (
                            <span key={index}>
                                {" / "}
                                <button onClick={() => go(parts.slice(0, index + 1).join("/"))}>
                                    {part}
                                </button>
                            </span>
                        ))}
                    </nav>
                    <input
                        type="search"
                        aria-label="Search artifact paths"
                        placeholder="Search paths…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <ErrorNotice error={files.error} />
                {files.isPending ? (
                    <Loading />
                ) : sorted.length ? (
                    <div className="scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Size</th>
                                    <th>Published</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {prefix && !query && (
                                    <tr>
                                        <td colSpan={4}>
                                            <button
                                                className="link"
                                                onClick={() => go(parts.slice(0, -1).join("/"))}
                                            >
                                                <Folder size={15} /> ..
                                            </button>
                                        </td>
                                    </tr>
                                )}
                                {sorted.map((row) => (
                                    <tr key={row.name}>
                                        <td>
                                            <button
                                                className="link"
                                                onClick={() =>
                                                    row.file
                                                        ? setSelected(row.file)
                                                        : go(
                                                              [prefix, row.name]
                                                                  .filter(Boolean)
                                                                  .join("/"),
                                                          )
                                                }
                                            >
                                                {row.folder ? (
                                                    <Folder size={15} />
                                                ) : (
                                                    <File size={15} />
                                                )}{" "}
                                                {row.name}
                                            </button>
                                        </td>
                                        <td className="muted">
                                            {row.file && bytes(row.file.size)}
                                        </td>
                                        <td className="muted">
                                            {row.file && date(row.file.updatedAt)}
                                        </td>
                                        <td>
                                            {row.file && (
                                                <a
                                                    href={`${endpoint}/${row.file.path}`}
                                                    download
                                                    aria-label={`Download ${row.name}`}
                                                >
                                                    <Download size={15} />
                                                </a>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <Empty>{query ? "No matching artifacts." : "No artifacts here yet."}</Empty>
                )}
                {files.data?.next && (
                    <button
                        className="button small"
                        onClick={() => setParams({ prefix, after: files.data!.next! })}
                    >
                        Next page
                    </button>
                )}
            </section>
            <section>
                <h2>{coordinate ? "Use this version" : "Add to your build"}</h2>
                <Code>{snippet}</Code>
                {coordinate && admin && (
                    <button className="button danger" onClick={() => setDeleting(true)}>
                        Delete version
                    </button>
                )}
            </section>
            {account.role && (
                <section>
                    <h2>Publications</h2>
                    <ErrorNotice error={publications.error} />
                    {publications.isPending ? (
                        <Loading />
                    ) : publications.data?.length ? (
                        <div className="scroll">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Publication</th>
                                        <th>Status</th>
                                        <th>Created</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {publications.data.map((publication) => (
                                        <tr key={publication.id}>
                                            <td>
                                                {publication.label || "Untitled"}{" "}
                                                <span className="mono muted">{publication.id}</span>
                                            </td>
                                            <td>
                                                <Badge
                                                    tone={
                                                        publication.status === "committed"
                                                            ? "green"
                                                            : publication.status === "open"
                                                              ? "amber"
                                                              : "neutral"
                                                    }
                                                >
                                                    {publication.status}
                                                </Badge>
                                            </td>
                                            <td className="muted">{date(publication.createdAt)}</td>
                                            <td>
                                                {admin && publication.status === "open" && (
                                                    <button
                                                        className="button small danger"
                                                        onClick={() => setAborting(publication.id)}
                                                    >
                                                        Abort
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <Empty>No publications yet.</Empty>
                    )}
                </section>
            )}
            {deleting && (
                <Confirm
                    title="Delete this version?"
                    action="Delete version"
                    pending={remove.isPending}
                    error={remove.error}
                    onConfirm={() => remove.mutate()}
                    onClose={() => setDeleting(false)}
                >
                    Every artifact under <code>{prefix}</code> will be removed and the repository
                    metadata updated.
                </Confirm>
            )}
            {aborting && (
                <Confirm
                    title="Abort this publication?"
                    action="Abort publication"
                    pending={abort.isPending}
                    error={abort.error}
                    onConfirm={() => abort.mutate()}
                    onClose={() => setAborting(null)}
                >
                    Staged files are discarded and reserved storage is released. A build still using
                    this publication will fail.
                </Confirm>
            )}
            {settings && repo && (
                <RepositoryForm repository={repo} close={() => setSettings(false)} />
            )}
            {selected && (
                <Modal title={selected.path.split("/").at(-1)!} onClose={() => setSelected(null)}>
                    <dl>
                        <dt>Path</dt>
                        <dd className="mono">{selected.path}</dd>
                        <dt>Size</dt>
                        <dd>{bytes(selected.size)}</dd>
                        <dt>Published</dt>
                        <dd>{date(selected.updatedAt)}</dd>
                        <dt>SHA-256</dt>
                        <dd>
                            <Code>{selected.sha256}</Code>
                        </dd>
                        <dt>URL</dt>
                        <dd>
                            <Code>{`${endpoint}/${selected.path}`}</Code>
                        </dd>
                    </dl>
                    <div className="form-footer">
                        <a
                            className="button primary"
                            href={`${endpoint}/${selected.path}`}
                            download
                        >
                            Download
                        </a>
                    </div>
                </Modal>
            )}
        </>
    );
}
