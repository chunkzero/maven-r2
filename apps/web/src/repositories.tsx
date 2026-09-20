import { useDeferredValue, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
    ArrowDownToLine,
    ArrowRight,
    Box,
    ChevronRight,
    File,
    Folder,
    Globe,
    HardDrive,
    Lock,
    Plus,
    Search,
    Settings2,
    Terminal,
    UploadCloud,
} from "lucide-react";
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
    CopyButton,
    date,
    Empty,
    ErrorNotice,
    Field,
    Loading,
    Modal,
    PageTitle,
} from "./components";

export function Repositories() {
    const { account } = useWorkspace(),
        repos = useApi(`/api/accounts/${account.slug}/repositories`, z.array(repositorySchema));
    const [creating, setCreating] = useState(false),
        [search, setSearch] = useState("");
    const admin = account.role === "owner" || account.role === "admin";
    const filtered = repos.data?.filter((repo) =>
        `${repo.name} ${repo.slug}`.toLowerCase().includes(search.toLowerCase()),
    );
    return (
        <>
            <PageTitle
                eyebrow={account.name}
                title="Repositories"
                description="A home for every package you build."
                action={
                    admin && (
                        <button className="button primary" onClick={() => setCreating(true)}>
                            <Plus size={17} />
                            New repository
                        </button>
                    )
                }
            />
            <div className="stats">
                <div>
                    <span className="stat-icon">
                        <Box size={19} />
                    </span>
                    <div>
                        <span className="stat-label">Repositories</span>
                        <strong>{repos.data?.length ?? "—"}</strong>
                    </div>
                </div>
                {account.role && (
                    <>
                        <div>
                            <span className="stat-icon">
                                <HardDrive size={19} />
                            </span>
                            <div>
                                <span className="stat-label">Artifact storage</span>
                                <strong>{bytes(account.usedBytes)}</strong>
                            </div>
                        </div>
                        <div>
                            <span className="stat-icon">
                                <UploadCloud size={19} />
                            </span>
                            <div>
                                <span className="stat-label">Staged uploads</span>
                                <strong>{bytes(account.reservedBytes)}</strong>
                            </div>
                        </div>
                    </>
                )}
            </div>
            <div className="section-heading">
                <h2>
                    All repositories <span className="count">{repos.data?.length ?? 0}</span>
                </h2>
                <div className="search">
                    <Search size={17} />
                    <input
                        aria-label="Find a repository"
                        placeholder="Find a repository…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>
            <ErrorNotice error={repos.error} />
            {repos.isPending ? (
                <Loading />
            ) : filtered?.length ? (
                <div className="repository-grid">
                    {filtered.map((repo) => (
                        <Link
                            className="repository-card"
                            to={`repositories/${repo.slug}`}
                            key={repo.id}
                        >
                            <div className="repository-card-top">
                                <div
                                    className={`repo-icon ${repo.policy === "snapshots" ? "violet" : ""}`}
                                >
                                    <Box size={23} />
                                </div>
                                <Badge>
                                    {repo.visibility === "private" ? (
                                        <Lock size={11} />
                                    ) : (
                                        <Globe size={11} />
                                    )}{" "}
                                    {repo.visibility}
                                </Badge>
                            </div>
                            <h3>{repo.name}</h3>
                            <p className="mono">
                                {account.slug}/{repo.slug}
                            </p>
                            <div className="repository-card-bottom">
                                <Badge tone={repo.policy === "releases" ? "green" : "neutral"}>
                                    {repo.policy}
                                </Badge>
                                <span>
                                    Browse artifacts <ArrowRight size={14} />
                                </span>
                            </div>
                        </Link>
                    ))}
                </div>
            ) : (
                <Empty
                    title={search ? "No matching repositories" : "Your first package starts here"}
                >
                    {search
                        ? "Try another repository name."
                        : "Create a repository, connect your build, and publish something great."}
                </Empty>
            )}
            <div className="callout">
                <div className="callout-icon">
                    <Terminal size={22} />
                </div>
                <div>
                    <h3>From your build to your repository.</h3>
                    <p>
                        Publish with the local CLI. Download from anywhere with a standard Maven
                        URL.
                    </p>
                </div>
                <a
                    className="text-link"
                    href="https://github.com/chunkzero/maven-r2#publishing"
                    target="_blank"
                    rel="noreferrer"
                >
                    Set up publishing <ArrowRight size={16} />
                </a>
            </div>
            {creating && <RepositoryForm close={() => setCreating(false)} />}
        </>
    );
}

export function RepositoryForm({
    close,
    repository,
}: {
    close: () => void;
    repository?: Repository;
}) {
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
                    ...(!repository ? { slug } : {}),
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
                        placeholder="Releases"
                    />
                </Field>
                {!repository && (
                    <Field label="URL slug">
                        <input
                            value={slug}
                            onChange={(e) => setSlug(e.target.value)}
                            required
                            pattern="[a-z0-9][a-z0-9-]{0,62}"
                            placeholder="releases"
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
                            <option value="mixed">Releases & snapshots</option>
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
                    <Field
                        label="Snapshot retention (days)"
                        hint="0 keeps all snapshots. Current snapshots are always retained."
                    >
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
                        {save.isPending
                            ? "Saving…"
                            : repository
                              ? "Save changes"
                              : "Create repository"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

type ArtifactFile = z.infer<typeof fileSchema>;
const fileList = z.object({ files: z.array(fileSchema), next: z.string().nullable() });
export function RepositoryBrowser() {
    const { account } = useWorkspace(),
        { repository: slug } = useParams(),
        [params, setParams] = useSearchParams();
    const prefix = params.get("prefix") ?? "",
        [search, setSearch] = useState(""),
        query = useDeferredValue(search);
    const base = `/api/accounts/${account.slug}/repositories/${slug}`;
    const repos = useApi(`/api/accounts/${account.slug}/repositories`, z.array(repositorySchema));
    const repo = repos.data?.find((repo) => repo.slug === slug);
    const files = useApi(
        `${base}/files?prefix=${encodeURIComponent(prefix)}&q=${encodeURIComponent(query.replaceAll(":", "/"))}&after=${encodeURIComponent(params.get("after") ?? "")}`,
        fileList,
    );
    const publications = useApi(`${base}/publications`, z.array(publicationSchema), !!account.role);
    const [settings, setSettings] = useState(false),
        [selected, setSelected] = useState<ArtifactFile | null>(null),
        [tab, setTab] = useState<"files" | "publications">("files");
    const admin = account.role === "owner" || account.role === "admin";
    const endpoint = `${location.origin}/maven/${account.slug}/${slug}`;
    const rows = new Map<string, { name: string; folder: boolean; file?: ArtifactFile }>();
    for (const file of files.data?.files ?? []) {
        const relative = prefix ? file.path.slice(prefix.length + 1) : file.path;
        if (query) rows.set(relative, { name: relative, folder: false, file });
        else {
            const parts = relative.split("/"),
                name = parts[0]!;
            rows.set(name, {
                name,
                folder: parts.length > 1,
                file: parts.length > 1 ? undefined : file,
            });
        }
    }
    const navigate = (path: string) => {
        setParams(path ? { prefix: path } : {});
        setSearch("");
    };
    const parts = prefix.split("/").filter(Boolean);
    const [deleting, setDeleting] = useState(false),
        [aborting, setAborting] = useState<string | null>(null);
    const remove = useAction(
        () => api(base + "/delete-version", ok, "POST", { path: prefix }),
        () => {
            setDeleting(false);
            navigate(parts.slice(0, -1).join("/"));
        },
    );
    const abort = useAction(
        () => api(`${base}/publications/${aborting}/abort`, publicationSchema, "POST"),
        () => setAborting(null),
    );
    const isVersion = !!files.data?.files.some(
        (file) =>
            file.path.startsWith(prefix + "/") &&
            !file.path.slice(prefix.length + 1).includes("/") &&
            file.path.endsWith(".pom"),
    );
    const pom = files.data?.files.find((file) => file.path.endsWith(".pom"));
    const gav = pom ? pom.path.split("/") : null;
    const coordinate = gav
        ? { group: gav.slice(0, -3).join("."), artifact: gav.at(-3)!, version: gav.at(-2)! }
        : null;
    return (
        <>
            <div className="backline">
                <Link to={`/a/${account.slug}`}>Repositories</Link>
                <ChevronRight size={13} />
                <span>{repo?.name ?? slug}</span>
            </div>
            <PageTitle
                title={repo?.name ?? slug ?? "Repository"}
                description={
                    repo?.policy === "snapshots"
                        ? "The latest builds, ready when you are."
                        : "Versioned artifacts. Ready to depend on."
                }
                action={
                    admin &&
                    repo && (
                        <button className="button" onClick={() => setSettings(true)}>
                            <Settings2 size={16} />
                            Settings
                        </button>
                    )
                }
            />
            <div className="repository-address">
                <div>
                    <Badge tone="green">{repo?.policy ?? "Maven"}</Badge>
                    <code>{endpoint}</code>
                </div>
                <CopyButton value={endpoint} label="Copy URL" />
            </div>
            <div className="tabs">
                <button
                    className={tab === "files" ? "selected" : ""}
                    onClick={() => setTab("files")}
                >
                    Browse artifacts
                </button>
                {account.role && (
                    <button
                        className={tab === "publications" ? "selected" : ""}
                        onClick={() => setTab("publications")}
                    >
                        Publications <span className="count">{publications.data?.length ?? 0}</span>
                    </button>
                )}
            </div>
            {tab === "files" ? (
                <div className="browser-layout">
                    <section className="panel file-panel">
                        <div className="file-toolbar">
                            <div className="breadcrumbs">
                                <button onClick={() => navigate("")} aria-label="Repository root">
                                    <Box size={16} />
                                </button>
                                {parts.map((part, index) => (
                                    <span key={index}>
                                        <ChevronRight size={13} />
                                        <button
                                            onClick={() =>
                                                navigate(parts.slice(0, index + 1).join("/"))
                                            }
                                        >
                                            {part}
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <div className="search compact">
                                <Search size={15} />
                                <input
                                    aria-label="Search artifact paths"
                                    placeholder="Search paths…"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>
                        </div>
                        <ErrorNotice error={files.error} />
                        {files.isPending ? (
                            <Loading />
                        ) : rows.size ? (
                            <>
                                <div className="table-scroll">
                                    <table className="file-table">
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
                                                            className="file-name"
                                                            onClick={() =>
                                                                navigate(
                                                                    parts.slice(0, -1).join("/"),
                                                                )
                                                            }
                                                        >
                                                            <Folder size={17} />
                                                            ..
                                                        </button>
                                                    </td>
                                                </tr>
                                            )}
                                            {[...rows.values()]
                                                .sort(
                                                    (a, b) =>
                                                        Number(b.folder) - Number(a.folder) ||
                                                        a.name.localeCompare(b.name),
                                                )
                                                .map((row) => (
                                                    <tr key={row.name}>
                                                        <td>
                                                            <button
                                                                className="file-name"
                                                                onClick={() =>
                                                                    row.folder
                                                                        ? navigate(
                                                                              [prefix, row.name]
                                                                                  .filter(Boolean)
                                                                                  .join("/"),
                                                                          )
                                                                        : setSelected(row.file!)
                                                                }
                                                            >
                                                                {row.folder ? (
                                                                    <Folder
                                                                        className="folder-icon"
                                                                        size={18}
                                                                    />
                                                                ) : (
                                                                    <File size={17} />
                                                                )}
                                                                <span>{row.name}</span>
                                                            </button>
                                                        </td>
                                                        <td className="muted">
                                                            {row.file ? bytes(row.file.size) : "—"}
                                                        </td>
                                                        <td className="muted small-text">
                                                            {row.file
                                                                ? new Date(
                                                                      row.file.updatedAt,
                                                                  ).toLocaleDateString()
                                                                : "—"}
                                                        </td>
                                                        <td>
                                                            {row.file ? (
                                                                <a
                                                                    href={
                                                                        endpoint +
                                                                        "/" +
                                                                        row.file.path
                                                                    }
                                                                    className="icon-button"
                                                                    download
                                                                    aria-label={`Download ${row.name}`}
                                                                >
                                                                    <ArrowDownToLine size={15} />
                                                                </a>
                                                            ) : (
                                                                <ChevronRight
                                                                    size={15}
                                                                    className="muted"
                                                                />
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                        </tbody>
                                    </table>
                                </div>
                                <div className="table-footer">
                                    <span>{rows.size} entries</span>
                                    {files.data?.next && (
                                        <button
                                            className="button small"
                                            onClick={() =>
                                                setParams({ prefix, after: files.data!.next! })
                                            }
                                        >
                                            Next page <ArrowRight size={14} />
                                        </button>
                                    )}
                                </div>
                            </>
                        ) : (
                            <Empty
                                title={
                                    query
                                        ? "No matching artifacts"
                                        : "Ready for your first publication"
                                }
                            >
                                {query
                                    ? "Try a different path or package name."
                                    : "Artifacts appear here after a successful publication."}
                            </Empty>
                        )}
                    </section>
                    <aside className="detail-sidebar">
                        <section className="panel">
                            <h3>Repository details</h3>
                            <dl>
                                <div>
                                    <dt>Visibility</dt>
                                    <dd>
                                        {repo?.visibility === "public" ? (
                                            <Globe size={13} />
                                        ) : (
                                            <Lock size={13} />
                                        )}{" "}
                                        {repo?.visibility}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Version policy</dt>
                                    <dd>{repo?.policy}</dd>
                                </div>
                                <div>
                                    <dt>Artifact limit</dt>
                                    <dd>{bytes(repo?.maxFileBytes ?? 0)}</dd>
                                </div>
                                <div>
                                    <dt>Snapshots</dt>
                                    <dd>
                                        {repo?.retentionDays
                                            ? `${repo.retentionDays} days`
                                            : "Keep all"}
                                    </dd>
                                </div>
                            </dl>
                        </section>
                        <section className="panel">
                            <h3>Add to your build</h3>
                            <p className="muted small-text">Gradle Kotlin DSL</p>
                            <Code>{`repositories {\n    maven {\n        url = uri("${endpoint}")\n    }\n}`}</Code>
                            {repo?.visibility === "private" && (
                                <p className="muted small-text">
                                    For private downloads, add repository credentials using a token
                                    with read access.
                                </p>
                            )}
                        </section>
                        {coordinate && (
                            <section className="panel">
                                <h3>Dependency</h3>
                                <Code>{`implementation("${coordinate.group}:${coordinate.artifact}:${coordinate.version}")`}</Code>
                                <Code>{`<dependency>\n  <groupId>${coordinate.group}</groupId>\n  <artifactId>${coordinate.artifact}</artifactId>\n  <version>${coordinate.version}</version>\n</dependency>`}</Code>
                            </section>
                        )}
                        {admin && isVersion && (
                            <section className="panel">
                                <h3>Manage this version</h3>
                                <p className="muted small-text">
                                    Remove all artifacts in this version and update repository
                                    metadata.
                                </p>
                                <button className="button danger" onClick={() => setDeleting(true)}>
                                    Delete version
                                </button>
                            </section>
                        )}
                    </aside>
                </div>
            ) : (
                <section className="panel">
                    <ErrorNotice error={publications.error} />
                    {publications.isPending ? (
                        <Loading />
                    ) : publications.data?.length ? (
                        <div className="table-scroll">
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
                                                <strong>
                                                    {publication.label || "Untitled publication"}
                                                </strong>
                                                <small className="mono muted block">
                                                    {publication.id}
                                                </small>
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
                        <Empty title="No publications yet">
                            Run the CLI with your build command to create your first publication.
                        </Empty>
                    )}
                </section>
            )}
            {deleting && (
                <Modal title="Delete this version?" onClose={() => setDeleting(false)}>
                    <p>
                        All artifacts at <code>{prefix}</code> will stop being available for
                        download.
                    </p>
                    <ErrorNotice error={remove.error} />
                    <div className="form-footer">
                        <button className="button" onClick={() => setDeleting(false)}>
                            Cancel
                        </button>
                        <button
                            className="button danger"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate()}
                        >
                            Delete version
                        </button>
                    </div>
                </Modal>
            )}
            {aborting && (
                <Modal title="Abort this publication?" onClose={() => setAborting(null)}>
                    <p>
                        Staged files will be discarded and reserved storage released. An active
                        build using this publication will fail.
                    </p>
                    <ErrorNotice error={abort.error} />
                    <div className="form-footer">
                        <button className="button" onClick={() => setAborting(null)}>
                            Cancel
                        </button>
                        <button
                            className="button danger"
                            disabled={abort.isPending}
                            onClick={() => abort.mutate()}
                        >
                            Abort publication
                        </button>
                    </div>
                </Modal>
            )}
            {settings && repo && (
                <RepositoryForm repository={repo} close={() => setSettings(false)} />
            )}
            {selected && (
                <FileDetails file={selected} endpoint={endpoint} close={() => setSelected(null)} />
            )}
        </>
    );
}
function FileDetails({
    file,
    endpoint,
    close,
}: {
    file: ArtifactFile;
    endpoint: string;
    close: () => void;
}) {
    return (
        <Modal title={file.path.split("/").at(-1)!} onClose={close}>
            <p className="mono muted break-word">{file.path}</p>
            <dl className="file-details">
                <div>
                    <dt>Size</dt>
                    <dd>{bytes(file.size)}</dd>
                </div>
                <div>
                    <dt>Published</dt>
                    <dd>{date(file.updatedAt)}</dd>
                </div>
                <div>
                    <dt>Content type</dt>
                    <dd>{file.contentType}</dd>
                </div>
            </dl>
            <Field label="SHA-256">
                <Code>{file.sha256}</Code>
            </Field>
            <Field label="Artifact URL">
                <Code>{endpoint + "/" + file.path}</Code>
            </Field>
            <div className="form-footer">
                <a className="button primary" href={endpoint + "/" + file.path} download>
                    <ArrowDownToLine size={16} />
                    Download artifact
                </a>
            </div>
        </Modal>
    );
}
