import * as stylex from "@stylexjs/stylex";
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
    Button,
    bytes,
    Code,
    Confirm,
    date,
    Empty,
    ErrorNotice,
    Field,
    Input,
    Loading,
    Modal,
    PageHeader,
    Select,
    Table,
    Td,
    ui,
} from "./components";

const styles = stylex.create({
    crumbs: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 },
    icon: { verticalAlign: -3 },
});

export function Repositories() {
    const { account } = useWorkspace(),
        repos = useApi(`/api/accounts/${account.slug}/repositories`, z.array(repositorySchema));
    const [creating, setCreating] = useState(false);
    const admin = account.role === "owner" || account.role === "admin";
    return (
        <>
            <PageHeader title="Repositories">
                {admin && (
                    <Button primary onClick={() => setCreating(true)}>
                        New repository
                    </Button>
                )}
            </PageHeader>
            {account.role && (
                <p {...stylex.props(ui.p, ui.muted)}>
                    {bytes(account.usedBytes)} stored · {bytes(account.reservedBytes)} staged ·{" "}
                    {bytes(account.maxBytes)} quota
                </p>
            )}
            <ErrorNotice error={repos.error} />
            {repos.isPending ? (
                <Loading />
            ) : repos.data?.length ? (
                <Table head={["Repository", "Visibility", "Policy", "Snapshot retention"]}>
                    {repos.data.map((repo) => (
                        <tr key={repo.id}>
                            <Td>
                                <Link to={`repositories/${repo.slug}`} {...stylex.props(ui.link)}>
                                    <strong>{repo.name}</strong>
                                </Link>{" "}
                                <span {...stylex.props(ui.mono, ui.muted)}>
                                    {account.slug}/{repo.slug}
                                </span>
                            </Td>
                            <Td>{repo.visibility}</Td>
                            <Td>{repo.policy}</Td>
                            <Td>
                                {repo.retentionDays ? `${repo.retentionDays} days` : "Keep all"}
                            </Td>
                        </tr>
                    ))}
                </Table>
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
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        maxLength={100}
                    />
                </Field>
                {!repository && (
                    <Field label="URL slug" hint="Lowercase letters, numbers, and hyphens.">
                        <Input
                            value={slug}
                            onChange={(e) => setSlug(e.target.value)}
                            required
                            pattern="[a-z0-9][a-z0-9-]{0,62}"
                        />
                    </Field>
                )}
                <div {...stylex.props(ui.row)}>
                    <Field label="Visibility">
                        <Select
                            value={visibility}
                            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                        >
                            <option value="private">Private</option>
                            <option value="public">Public</option>
                        </Select>
                    </Field>
                    <Field label="Version policy">
                        <Select
                            value={policy}
                            onChange={(e) => setPolicy(e.target.value as typeof policy)}
                        >
                            <option value="releases">Releases</option>
                            <option value="snapshots">Snapshots</option>
                            <option value="mixed">Releases and snapshots</option>
                        </Select>
                    </Field>
                </div>
                <div {...stylex.props(ui.row)}>
                    <Field label="Maximum artifact size (MiB)">
                        <Input
                            type="number"
                            value={limit}
                            onChange={(e) => setLimit(Number(e.target.value))}
                            min={1}
                            max={2048}
                            required
                        />
                    </Field>
                    <Field label="Snapshot retention (days)" hint="0 keeps every snapshot.">
                        <Input
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
                <div {...stylex.props(ui.footer)}>
                    <Button type="button" onClick={close}>
                        Cancel
                    </Button>
                    <Button primary disabled={save.isPending}>
                        {repository ? "Save changes" : "Create repository"}
                    </Button>
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
    const downloadEndpoint = `${location.origin}/maven/${account.slug}/${slug}`;
    const endpoint = repo?.url ?? downloadEndpoint;
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
    const repositorySnippet = [
        "repositories {",
        "    maven {",
        `        url = uri("${endpoint}")`,
        ...(endpoint.startsWith("http:") ? ["        isAllowInsecureProtocol = true"] : []),
        ...(repo?.visibility === "private"
            ? [
                  "        credentials {",
                  '            username = "maven-r2"',
                  '            password = providers.environmentVariable("MAVEN_R2_READ_TOKEN").get()',
                  "        }",
              ]
            : []),
        "    }",
        "}",
    ].join("\n");
    const snippet = coordinate
        ? `${repositorySnippet}\ndependencies {\n    implementation("${coordinate}")\n}`
        : repositorySnippet;

    return (
        <>
            <PageHeader
                title={
                    <>
                        <Link to={`/${account.slug}`} {...stylex.props(ui.quietLink)}>
                            Repositories
                        </Link>{" "}
                        / {repo?.name ?? slug}
                    </>
                }
            >
                {admin && repo && <Button onClick={() => setSettings(true)}>Settings</Button>}
            </PageHeader>
            {repo && (
                <p {...stylex.props(ui.p, ui.muted)}>
                    {repo.visibility} · {repo.policy} · files up to {bytes(repo.maxFileBytes)} ·{" "}
                    {repo.retentionDays
                        ? `snapshots kept ${repo.retentionDays} days`
                        : "all snapshots kept"}
                </p>
            )}
            <Code>{endpoint}</Code>
            <section>
                <div {...stylex.props(ui.toolbar)}>
                    <nav {...stylex.props(styles.crumbs)} aria-label="Path">
                        <button {...stylex.props(ui.textButton)} onClick={() => go("")}>
                            {slug}
                        </button>
                        {parts.map((part, index) => (
                            <span key={index} {...stylex.props(styles.crumbs)}>
                                <span {...stylex.props(ui.muted)}>/</span>
                                <button
                                    {...stylex.props(ui.textButton)}
                                    onClick={() => go(parts.slice(0, index + 1).join("/"))}
                                >
                                    {part}
                                </button>
                            </span>
                        ))}
                    </nav>
                    <Input
                        sx={ui.auto}
                        type="search"
                        aria-label="Search artifact paths"
                        placeholder="Search paths…"
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            setParams(prefix ? { prefix } : {}, { replace: true });
                        }}
                    />
                </div>
                <ErrorNotice error={files.error} />
                {files.isPending ? (
                    <Loading />
                ) : sorted.length ? (
                    <Table head={["Name", "Size", "Published", ""]}>
                        {prefix && !query && (
                            <tr>
                                <Td colSpan={4}>
                                    <button
                                        {...stylex.props(ui.textButton)}
                                        onClick={() => go(parts.slice(0, -1).join("/"))}
                                    >
                                        <Folder size={15} /> ..
                                    </button>
                                </Td>
                            </tr>
                        )}
                        {sorted.map((row) => (
                            <tr key={row.name}>
                                <Td>
                                    <button
                                        {...stylex.props(ui.textButton)}
                                        onClick={() =>
                                            row.file
                                                ? setSelected(row.file)
                                                : go([prefix, row.name].filter(Boolean).join("/"))
                                        }
                                    >
                                        {row.folder ? <Folder size={15} /> : <File size={15} />}
                                        {row.name}
                                    </button>
                                </Td>
                                <Td muted>{row.file && bytes(row.file.size)}</Td>
                                <Td muted>{row.file && date(row.file.updatedAt)}</Td>
                                <Td right>
                                    {row.file && (
                                        <a
                                            href={`${downloadEndpoint}/${row.file.path}`}
                                            download={row.file.path.split("/").at(-1)}
                                            aria-label={`Download ${row.name}`}
                                            {...stylex.props(ui.quietLink)}
                                        >
                                            <Download size={15} {...stylex.props(styles.icon)} />
                                        </a>
                                    )}
                                </Td>
                            </tr>
                        ))}
                    </Table>
                ) : (
                    <Empty>{query ? "No matching artifacts." : "No artifacts here yet."}</Empty>
                )}
                {files.data?.next && (
                    <Button small onClick={() => setParams({ prefix, after: files.data!.next! })}>
                        Next page
                    </Button>
                )}
            </section>
            <section>
                <h2 {...stylex.props(ui.h2)}>
                    {coordinate ? "Use this version" : "Add to your build"}
                </h2>
                <Code>{snippet}</Code>
                {repo?.visibility === "private" && (
                    <p {...stylex.props(ui.p, ui.muted)}>
                        Set <code>MAVEN_R2_READ_TOKEN</code> to a token with read access to this
                        repository and artifact namespace.
                    </p>
                )}
                {coordinate && admin && (
                    <Button onClick={() => setDeleting(true)}>Delete version</Button>
                )}
            </section>
            {account.role && (
                <section>
                    <h2 {...stylex.props(ui.h2)}>Publications</h2>
                    <ErrorNotice error={publications.error} />
                    {publications.isPending ? (
                        <Loading />
                    ) : publications.data?.length ? (
                        <Table head={["Publication", "Status", "Created", ""]}>
                            {publications.data.map((publication) => (
                                <tr key={publication.id}>
                                    <Td>
                                        {publication.label || "Untitled"}{" "}
                                        <span {...stylex.props(ui.mono, ui.muted)}>
                                            {publication.id}
                                        </span>
                                    </Td>
                                    <Td>
                                        <Badge>{publication.status}</Badge>
                                    </Td>
                                    <Td muted>{date(publication.createdAt)}</Td>
                                    <Td right>
                                        {admin && publication.status === "open" && (
                                            <Button
                                                small
                                                onClick={() => setAborting(publication.id)}
                                            >
                                                Abort
                                            </Button>
                                        )}
                                    </Td>
                                </tr>
                            ))}
                        </Table>
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
                    <dl {...stylex.props(ui.dl)}>
                        <dt {...stylex.props(ui.dt)}>Path</dt>
                        <dd {...stylex.props(ui.dd, ui.mono)}>{selected.path}</dd>
                        <dt {...stylex.props(ui.dt)}>Size</dt>
                        <dd {...stylex.props(ui.dd)}>{bytes(selected.size)}</dd>
                        <dt {...stylex.props(ui.dt)}>Published</dt>
                        <dd {...stylex.props(ui.dd)}>{date(selected.updatedAt)}</dd>
                        <dt {...stylex.props(ui.dt)}>SHA-256</dt>
                        <dd {...stylex.props(ui.dd)}>
                            <Code>{selected.sha256}</Code>
                        </dd>
                        <dt {...stylex.props(ui.dt)}>URL</dt>
                        <dd {...stylex.props(ui.dd)}>
                            <Code>{`${endpoint}/${selected.path}`}</Code>
                        </dd>
                    </dl>
                    <div {...stylex.props(ui.footer)}>
                        <a
                            href={`${downloadEndpoint}/${selected.path}`}
                            download={selected.path.split("/").at(-1)}
                            {...stylex.props(ui.button, ui.primary)}
                        >
                            Download
                        </a>
                    </div>
                </Modal>
            )}
        </>
    );
}
