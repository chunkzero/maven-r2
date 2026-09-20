import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { z } from "zod";
import {
    action,
    repositorySchema,
    serviceAccountSchema,
    tokenSchema,
    type Action,
} from "@maven-r2/contracts/schemas";
import { api, ok, useAction, useApi } from "./api";
import { useWorkspace } from "./app";
import {
    Badge,
    Button,
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
    Textarea,
    ui,
} from "./components";

type Token = z.infer<typeof tokenSchema>;
const expiry = (days: string) => (days === "never" ? null : Date.now() + Number(days) * 86_400_000);
const labels: Record<Action, string> = {
    read: "Read artifacts",
    "publish:release": "Publish releases",
    "publish:snapshot": "Publish snapshots",
    delete: "Delete versions",
};

export function Tokens() {
    const { account } = useWorkspace(),
        base = `/api/accounts/${account.slug}`,
        tokens = useApi(base + "/tokens", z.array(tokenSchema));
    const [creating, setCreating] = useState(false),
        [revoking, setRevoking] = useState<Token | null>(null);
    const revoke = useAction(
        () => api(base + "/tokens/" + revoking!.id, ok, "DELETE"),
        () => setRevoking(null),
    );
    return (
        <>
            <PageHeader title="Tokens">
                <Button primary onClick={() => setCreating(true)}>
                    Create token
                </Button>
            </PageHeader>
            <p {...stylex.props(ui.p, ui.muted)}>
                Tokens are scoped to a repository and optional path prefixes. Use a service account
                for CI so access does not depend on a person.
            </p>
            <ErrorNotice error={tokens.error} />
            {tokens.isPending ? (
                <Loading />
            ) : tokens.data?.length ? (
                <Table head={["Token", "Scope", "Last used", "Expires", ""]}>
                    {tokens.data.map((token) => (
                        <tr key={token.id}>
                            <Td>
                                <strong>{token.name}</strong>{" "}
                                <span {...stylex.props(ui.mono, ui.muted)}>{token.prefix}…</span>{" "}
                                {token.revoked && <Badge>Revoked</Badge>}
                            </Td>
                            <Td>
                                {token.scopes.map((scope, index) => (
                                    <div key={index}>
                                        <span {...stylex.props(ui.mono)}>
                                            {scope.repository}/
                                            {scope.prefixes
                                                .map((prefix) => prefix || "**")
                                                .join(", ")}
                                        </span>{" "}
                                        <span {...stylex.props(ui.muted)}>
                                            {scope.actions.join(", ")}
                                        </span>
                                    </div>
                                ))}
                            </Td>
                            <Td muted>{token.lastUsedAt ? date(token.lastUsedAt) : "Never"}</Td>
                            <Td muted>{token.expiresAt ? date(token.expiresAt) : "Never"}</Td>
                            <Td right>
                                {!token.revoked && (
                                    <Button
                                        small
                                        aria-label={`Revoke ${token.name}`}
                                        onClick={() => setRevoking(token)}
                                    >
                                        Revoke
                                    </Button>
                                )}
                            </Td>
                        </tr>
                    ))}
                </Table>
            ) : (
                <Empty>No tokens yet.</Empty>
            )}
            {creating && <CreateToken close={() => setCreating(false)} />}
            {revoking && (
                <Confirm
                    title="Revoke this token?"
                    action="Revoke token"
                    pending={revoke.isPending}
                    error={revoke.error}
                    onConfirm={() => revoke.mutate()}
                    onClose={() => setRevoking(null)}
                >
                    Requests using <strong>{revoking.name}</strong> are denied immediately.
                </Confirm>
            )}
        </>
    );
}

function CreateToken({ close }: { close: () => void }) {
    const { account } = useWorkspace(),
        base = `/api/accounts/${account.slug}`,
        admin = account.role === "owner" || account.role === "admin";
    const repos = useApi(base + "/repositories", z.array(repositorySchema)),
        services = useApi(base + "/services", z.array(serviceAccountSchema), admin);
    const [name, setName] = useState(""),
        [repository, setRepository] = useState(""),
        [service, setService] = useState(""),
        [prefixes, setPrefixes] = useState(""),
        [days, setDays] = useState("30"),
        [permissions, setPermissions] = useState<Action[]>([
            "read",
            "publish:release",
            "publish:snapshot",
        ]),
        [secret, setSecret] = useState("");
    const repo = repository || repos.data?.[0]?.slug || "";
    const owner = service ? services.data?.find((item) => item.id === service) : null;
    const publish = (owner?.role ?? account.role) !== "reader";
    const available = action.options.filter((item) =>
        item === "read" ? true : item === "delete" ? admin && !service : publish,
    );
    const chosen = permissions.filter((permission) => available.includes(permission));
    const paths = prefixes
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
    const create = useAction(async () => {
        const result = await api(
            base + "/tokens",
            z.object({ secret: z.string(), token: tokenSchema }),
            "POST",
            {
                name,
                scopes: [
                    {
                        repository: repo,
                        prefixes: paths.length ? paths : [""],
                        actions: chosen,
                    },
                ],
                ...(service ? { serviceAccountId: service } : {}),
                expiresAt: expiry(days),
            },
        );
        setSecret(result.secret);
    });
    if (secret)
        return (
            <Modal title="Your token is ready" onClose={close}>
                <p {...stylex.props(ui.p)}>Copy it now. It is shown only once.</p>
                <Code>{secret}</Code>
                <p {...stylex.props(ui.p, ui.muted)}>
                    Store it as <code>MAVEN_R2_TOKEN</code> in CI, or pass it to{" "}
                    <code>maven-r2 login</code>.
                </p>
                <div {...stylex.props(ui.footer)}>
                    <Button primary onClick={close}>
                        Done
                    </Button>
                </div>
            </Modal>
        );
    return (
        <Modal title="Create an access token" onClose={close}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                }}
            >
                <Field label="Token name">
                    <Input
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={100}
                    />
                </Field>
                <div {...stylex.props(ui.row)}>
                    {admin && (
                        <Field label="Owner">
                            <Select value={service} onChange={(e) => setService(e.target.value)}>
                                <option value="">My account</option>
                                {services.data
                                    ?.filter((service) => !service.disabled)
                                    .map((service) => (
                                        <option value={service.id} key={service.id}>
                                            {service.name}
                                        </option>
                                    ))}
                            </Select>
                        </Field>
                    )}
                    <Field label="Repository">
                        <Select
                            required
                            value={repo}
                            onChange={(e) => setRepository(e.target.value)}
                        >
                            {repos.data?.map((repo) => (
                                <option key={repo.id} value={repo.slug}>
                                    {repo.name}
                                </option>
                            ))}
                        </Select>
                    </Field>
                </div>
                <Field
                    label="Allowed namespaces or paths"
                    hint="One path prefix per line, such as com/acme/sdk. Leave blank for the whole repository."
                >
                    <Textarea
                        value={prefixes}
                        onChange={(e) => setPrefixes(e.target.value)}
                        rows={3}
                    />
                </Field>
                <fieldset {...stylex.props(ui.fieldset)}>
                    <legend {...stylex.props(ui.legend)}>Allowed operations</legend>
                    {available.map((permission) => (
                        <label key={permission} {...stylex.props(ui.check)}>
                            <input
                                type="checkbox"
                                checked={permissions.includes(permission)}
                                onChange={(e) =>
                                    setPermissions(
                                        e.target.checked
                                            ? [...permissions, permission]
                                            : permissions.filter((item) => item !== permission),
                                    )
                                }
                            />
                            {labels[permission]}
                        </label>
                    ))}
                </fieldset>
                <Field label="Expires after">
                    <Select value={days} onChange={(e) => setDays(e.target.value)}>
                        <option value="30">30 days</option>
                        <option value="90">90 days</option>
                        <option value="365">1 year</option>
                        <option value="never">Never</option>
                    </Select>
                </Field>
                <ErrorNotice error={create.error} />
                <div {...stylex.props(ui.footer)}>
                    <Button type="button" onClick={close}>
                        Cancel
                    </Button>
                    <Button primary disabled={create.isPending || !repo || !chosen.length}>
                        Create token
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
