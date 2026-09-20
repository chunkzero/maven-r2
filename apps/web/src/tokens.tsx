import { useState } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
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
    date,
    Empty,
    ErrorNotice,
    Field,
    Loading,
    Modal,
    PageTitle,
} from "./components";

type Token = z.infer<typeof tokenSchema>;
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
            <PageTitle
                eyebrow={account.name}
                title="Access tokens"
                description="Give every build exactly the access it needs."
                action={
                    account.role && (
                        <button className="button primary" onClick={() => setCreating(true)}>
                            <Plus size={17} />
                            Create token
                        </button>
                    )
                }
            />
            <div className="notice">
                <ShieldCheck size={20} />
                <span>
                    Tokens are scoped to repositories and paths. Use a service account for CI so
                    access stays independent of a person.
                </span>
            </div>
            <ErrorNotice error={tokens.error} />
            <section className="panel">
                {tokens.isPending ? (
                    <Loading />
                ) : tokens.data?.length ? (
                    <div className="table-scroll">
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
                                            <div className="row-label">
                                                <KeyRound size={17} />
                                                <div>
                                                    <strong>{token.name}</strong>
                                                    <small className="mono muted block">
                                                        {token.prefix}…
                                                    </small>
                                                </div>
                                            </div>
                                            {token.revoked && <Badge>Revoked</Badge>}
                                        </td>
                                        <td>
                                            {token.scopes.map((scope, index) => (
                                                <div className="token-scope" key={index}>
                                                    <Badge>{scope.repository}</Badge>
                                                    <span className="mono small-text">
                                                        {scope.prefixes
                                                            .map(
                                                                (prefix) =>
                                                                    (prefix || "*") +
                                                                    (prefix ? "/**" : ""),
                                                            )
                                                            .join(", ")}
                                                    </span>
                                                    <small className="muted">
                                                        {scope.actions.join(" · ")}
                                                    </small>
                                                </div>
                                            ))}
                                        </td>
                                        <td className="muted small-text">
                                            {token.lastUsedAt ? date(token.lastUsedAt) : "Never"}
                                        </td>
                                        <td className="muted small-text">
                                            {token.expiresAt ? date(token.expiresAt) : "No expiry"}
                                        </td>
                                        <td>
                                            {!token.revoked && (
                                                <button
                                                    className="icon-button danger"
                                                    aria-label={`Revoke ${token.name}`}
                                                    onClick={() => setRevoking(token)}
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <Empty title="Your builds' keys to the registry">
                        Create a token for your local proxy or CI pipeline.
                    </Empty>
                )}
            </section>
            {creating && <CreateToken close={() => setCreating(false)} />}
            {revoking && (
                <Modal title="Revoke this token?" onClose={() => setRevoking(null)}>
                    <p>
                        New requests using <strong>{revoking.name}</strong> will be denied
                        immediately. Pipelines using it will need a replacement token.
                    </p>
                    <ErrorNotice error={revoke.error} />
                    <div className="form-footer">
                        <button className="button" onClick={() => setRevoking(null)}>
                            Cancel
                        </button>
                        <button
                            className="button danger-button"
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate()}
                        >
                            Revoke token
                        </button>
                    </div>
                </Modal>
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
    const selectedService = services.data?.find((item) => item.id === service);
    const mayPublish = account.role !== "reader" && selectedService?.role !== "reader";
    const available = action.options.filter((item) =>
        item === "read" || item === "delete" ? item === "read" || (admin && !service) : mayPublish,
    );
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
                        prefixes: prefixes.trim()
                            ? prefixes
                                  .split(/\n|,/)
                                  .map((value) => value.trim())
                                  .filter(Boolean)
                            : [""],
                        actions: permissions.filter((permission) => available.includes(permission)),
                    },
                ],
                ...(service ? { serviceAccountId: service } : {}),
                expiresAt: days === "never" ? null : Date.now() + Number(days) * 86400000,
            },
        );
        setSecret(result.secret);
    });
    return (
        <Modal title={secret ? "Your token is ready" : "Create an access token"} onClose={close}>
            {secret ? (
                <>
                    <div className="notice">
                        <ShieldCheck size={20} />
                        <span>Copy this token now. It will only be shown once.</span>
                    </div>
                    <Code>{secret}</Code>
                    <p className="muted">
                        Save it in your CI secret store as <code>MAVEN_R2_TOKEN</code>, or enter it
                        when running <code>maven-r2 login</code>.
                    </p>
                    <div className="form-footer">
                        <button className="button primary" onClick={close}>
                            Done
                        </button>
                    </div>
                </>
            ) : (
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
                            placeholder="GitHub Actions — releases"
                        />
                    </Field>
                    <div className="form-row">
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
                            placeholder="com/acme/sdk"
                        />
                    </Field>
                    <fieldset className="permissions">
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
                                {
                                    {
                                        read: "Read artifacts",
                                        "publish:release": "Publish releases",
                                        "publish:snapshot": "Publish snapshots",
                                        delete: "Delete versions",
                                    }[permission]
                                }
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
                    <div className="scope-preview">
                        <strong>Access preview</strong>
                        <span className="mono">
                            {account.slug}/{repo}/
                            {prefixes.trim() ? prefixes.split(/\n|,/)[0] : "*"}
                            {prefixes.trim() ? "/**" : ""}
                        </span>
                        <small>
                            {permissions
                                .filter((permission) => available.includes(permission))
                                .join(" · ") || "Select at least one operation"}
                        </small>
                    </div>
                    <ErrorNotice error={create.error} />
                    <div className="form-footer">
                        <button type="button" className="button" onClick={close}>
                            Cancel
                        </button>
                        <button
                            className="button primary"
                            disabled={
                                create.isPending ||
                                !repo ||
                                !permissions.some((permission) => available.includes(permission))
                            }
                        >
                            Create token
                        </button>
                    </div>
                </form>
            )}
        </Modal>
    );
}
