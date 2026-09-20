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
                <button className="button primary" onClick={() => setCreating(true)}>
                    Create token
                </button>
            </PageHeader>
            <p className="muted">
                Tokens are scoped to a repository and optional path prefixes. Use a service account
                for CI so access does not depend on a person.
            </p>
            <ErrorNotice error={tokens.error} />
            {tokens.isPending ? (
                <Loading />
            ) : tokens.data?.length ? (
                <div className="scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>Token</th>
                                <th>Scope</th>
                                <th>Last used</th>
                                <th>Expires</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {tokens.data.map((token) => (
                                <tr key={token.id}>
                                    <td>
                                        <strong>{token.name}</strong>{" "}
                                        <span className="mono muted">{token.prefix}…</span>{" "}
                                        {token.revoked && <Badge>Revoked</Badge>}
                                    </td>
                                    <td>
                                        {token.scopes.map((scope, index) => (
                                            <div key={index}>
                                                <span className="mono">
                                                    {scope.repository}/
                                                    {scope.prefixes
                                                        .map((prefix) => prefix || "**")
                                                        .join(", ")}
                                                </span>{" "}
                                                <span className="muted">
                                                    {scope.actions.join(", ")}
                                                </span>
                                            </div>
                                        ))}
                                    </td>
                                    <td className="muted">
                                        {token.lastUsedAt ? date(token.lastUsedAt) : "Never"}
                                    </td>
                                    <td className="muted">
                                        {token.expiresAt ? date(token.expiresAt) : "Never"}
                                    </td>
                                    <td>
                                        {!token.revoked && (
                                            <button
                                                className="button small danger"
                                                aria-label={`Revoke ${token.name}`}
                                                onClick={() => setRevoking(token)}
                                            >
                                                Revoke
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
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
                <p>Copy it now. It is shown only once.</p>
                <Code>{secret}</Code>
                <p className="muted">
                    Store it as <code>MAVEN_R2_TOKEN</code> in CI, or pass it to{" "}
                    <code>maven-r2 login</code>.
                </p>
                <div className="form-footer">
                    <button className="button primary" onClick={close}>
                        Done
                    </button>
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
                    <input
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={100}
                    />
                </Field>
                <div className="form-row">
                    {admin && (
                        <Field label="Owner">
                            <select value={service} onChange={(e) => setService(e.target.value)}>
                                <option value="">My account</option>
                                {services.data
                                    ?.filter((service) => !service.disabled)
                                    .map((service) => (
                                        <option value={service.id} key={service.id}>
                                            {service.name}
                                        </option>
                                    ))}
                            </select>
                        </Field>
                    )}
                    <Field label="Repository">
                        <select
                            required
                            value={repo}
                            onChange={(e) => setRepository(e.target.value)}
                        >
                            {repos.data?.map((repo) => (
                                <option key={repo.id} value={repo.slug}>
                                    {repo.name}
                                </option>
                            ))}
                        </select>
                    </Field>
                </div>
                <Field
                    label="Allowed namespaces or paths"
                    hint="One path prefix per line, such as com/acme/sdk. Leave blank for the whole repository."
                >
                    <textarea
                        value={prefixes}
                        onChange={(e) => setPrefixes(e.target.value)}
                        rows={3}
                    />
                </Field>
                <fieldset>
                    <legend>Allowed operations</legend>
                    {available.map((permission) => (
                        <label key={permission}>
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
                    <select value={days} onChange={(e) => setDays(e.target.value)}>
                        <option value="30">30 days</option>
                        <option value="90">90 days</option>
                        <option value="365">1 year</option>
                        <option value="never">Never</option>
                    </select>
                </Field>
                <ErrorNotice error={create.error} />
                <div className="form-footer">
                    <button type="button" className="button" onClick={close}>
                        Cancel
                    </button>
                    <button
                        className="button primary"
                        disabled={create.isPending || !repo || !chosen.length}
                    >
                        Create token
                    </button>
                </div>
            </form>
        </Modal>
    );
}
