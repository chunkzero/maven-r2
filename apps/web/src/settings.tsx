import { useState } from "react";
import { Link, useParams } from "react-router";
import { Activity, Bot, Check, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { z } from "zod";
import {
    auditSchema,
    invitationSchema,
    memberSchema,
    serviceAccountSchema,
} from "@maven-r2/contracts/schemas";
import { api, ok, useAction, useApi } from "./api";
import { useWorkspace } from "./app";
import {
    Badge,
    bytes,
    Code,
    date,
    Empty,
    ErrorNotice,
    Field,
    Loading,
    Modal,
    PageTitle,
} from "./components";

export function Members() {
    const [now] = useState(Date.now);
    const { account } = useWorkspace(),
        base = `/api/accounts/${account.slug}`;
    const members = useApi(base + "/members", z.array(memberSchema)),
        services = useApi(base + "/services", z.array(serviceAccountSchema)),
        invitations = useApi(base + "/invitations", z.array(invitationSchema));
    const [invite, setInvite] = useState(false),
        [service, setService] = useState(false),
        [remove, setRemove] = useState<{
            type: "members" | "services";
            id: string;
            name: string;
        } | null>(null);
    const removeAction = useAction(
        () => api(`${base}/${remove!.type}/${remove!.id}`, ok, "DELETE"),
        () => setRemove(null),
    );
    const revokeInvite = useAction((id: string) => api(`${base}/invitations/${id}`, ok, "DELETE"));
    const changeRole = useAction(({ id, role }: { id: string; role: string }) =>
        api(`${base}/members/${id}`, ok, "PATCH", { role }),
    );
    return (
        <>
            <PageTitle
                eyebrow={account.name}
                title="Members & services"
                description="The people and pipelines behind your packages."
                action={
                    <button className="button primary" onClick={() => setInvite(true)}>
                        <UserPlus size={17} />
                        Invite member
                    </button>
                }
            />
            <ErrorNotice error={members.error ?? services.error ?? changeRole.error} />
            <section className="panel">
                <div className="panel-heading">
                    <h2>Members</h2>
                    <Badge>{members.data?.length ?? 0}</Badge>
                </div>
                {members.isPending ? (
                    <Loading />
                ) : members.data?.length ? (
                    <div className="table-scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>Member</th>
                                    <th>Role</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {members.data.map((member) => (
                                    <tr key={member.userId}>
                                        <td>
                                            <strong>{member.name}</strong>
                                            <small className="muted block">{member.email}</small>
                                        </td>
                                        <td>
                                            <select
                                                className="inline-select"
                                                aria-label={`Role for ${member.name}`}
                                                value={member.role}
                                                disabled={
                                                    changeRole.isPending ||
                                                    (member.role === "owner" &&
                                                        account.role !== "owner")
                                                }
                                                onChange={(e) =>
                                                    changeRole.mutate({
                                                        id: member.userId,
                                                        role: e.target.value,
                                                    })
                                                }
                                            >
                                                {[
                                                    "reader",
                                                    "publisher",
                                                    "admin",
                                                    ...(account.role === "owner"
                                                        ? ["owner"]
                                                        : member.role === "owner"
                                                          ? ["owner"]
                                                          : []),
                                                ].map((role) => (
                                                    <option key={role} value={role}>
                                                        {role}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>
                                        <td>
                                            <button
                                                className="icon-button danger"
                                                aria-label={`Remove ${member.name}`}
                                                onClick={() =>
                                                    setRemove({
                                                        type: "members",
                                                        id: member.userId,
                                                        name: member.name,
                                                    })
                                                }
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <Empty title="No members yet">
                        Instance administrators can invite the first members.
                    </Empty>
                )}
            </section>
            <div className="section-heading spaced">
                <div>
                    <h2>Service accounts</h2>
                    <p className="muted">Dedicated identities for CI and automation.</p>
                </div>
                <button className="button" onClick={() => setService(true)}>
                    <Plus size={16} />
                    New service account
                </button>
            </div>
            <section className="panel">
                {services.data?.length ? (
                    <div className="table-scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>Service</th>
                                    <th>Role</th>
                                    <th>Status</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {services.data.map((service) => (
                                    <tr key={service.id}>
                                        <td>
                                            <div className="row-label">
                                                <Bot size={19} />
                                                <strong>{service.name}</strong>
                                            </div>
                                        </td>
                                        <td>
                                            <Badge>{service.role}</Badge>
                                        </td>
                                        <td>
                                            <Badge tone={service.disabled ? "neutral" : "green"}>
                                                {service.disabled ? "Disabled" : "Active"}
                                            </Badge>
                                        </td>
                                        <td>
                                            {!service.disabled && (
                                                <button
                                                    className="icon-button danger"
                                                    aria-label={`Disable ${service.name}`}
                                                    onClick={() =>
                                                        setRemove({
                                                            type: "services",
                                                            id: service.id,
                                                            name: service.name,
                                                        })
                                                    }
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
                    <Empty title="Give your pipeline its own identity">
                        Create a service account, then issue a scoped token for it.
                    </Empty>
                )}
            </section>
            {!!invitations.data?.length && (
                <>
                    <div className="section-heading spaced">
                        <h2>Invitations</h2>
                        <ErrorNotice error={revokeInvite.error} />
                    </div>
                    <section className="panel">
                        <div className="table-scroll">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Email</th>
                                        <th>Role</th>
                                        <th>Status</th>
                                        <th>Expires</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {invitations.data.map((invite) => (
                                        <tr key={invite.id}>
                                            <td>{invite.email}</td>
                                            <td>
                                                <Badge>{invite.role}</Badge>
                                            </td>
                                            <td>
                                                {invite.accepted
                                                    ? "Accepted"
                                                    : invite.expiresAt < now
                                                      ? "Expired"
                                                      : "Pending"}
                                            </td>
                                            <td className="muted small-text">
                                                {date(invite.expiresAt)}
                                            </td>
                                            <td>
                                                {!invite.accepted && invite.expiresAt > now && (
                                                    <button
                                                        className="button small"
                                                        disabled={revokeInvite.isPending}
                                                        onClick={() =>
                                                            revokeInvite.mutate(invite.id)
                                                        }
                                                    >
                                                        Revoke invitation
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </>
            )}
            {invite && <InviteForm close={() => setInvite(false)} />}
            {service && <ServiceForm close={() => setService(false)} />}
            {remove && (
                <Modal
                    title={
                        remove.type === "services" ? "Disable service account?" : "Remove member?"
                    }
                    onClose={() => setRemove(null)}
                >
                    <p>
                        <strong>{remove.name}</strong> will lose access to this workspace. Their
                        tokens will stop authorizing new requests.
                    </p>
                    <ErrorNotice error={removeAction.error} />
                    <div className="form-footer">
                        <button className="button" onClick={() => setRemove(null)}>
                            Cancel
                        </button>
                        <button
                            className="button danger-button"
                            disabled={removeAction.isPending}
                            onClick={() => removeAction.mutate()}
                        >
                            Remove access
                        </button>
                    </div>
                </Modal>
            )}
        </>
    );
}
function InviteForm({ close }: { close: () => void }) {
    const { account } = useWorkspace();
    const [email, setEmail] = useState(""),
        [role, setRole] = useState("publisher"),
        [url, setUrl] = useState("");
    const invite = useAction(async () => {
        const result = await api(
            `/api/accounts/${account.slug}/invitations`,
            z.object({ id: z.string(), url: z.string(), expiresAt: z.number() }),
            "POST",
            { email, role },
        );
        setUrl(result.url);
    });
    return (
        <Modal title={url ? "Invitation ready" : "Invite a teammate"} onClose={close}>
            {url ? (
                <>
                    <p>
                        Share this link with <strong>{email}</strong>. They must sign in with that
                        verified email address. The link expires in seven days.
                    </p>
                    <Code>{url}</Code>
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
                        invite.mutate();
                    }}
                >
                    <Field label="Email address">
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            placeholder="teammate@acme.com"
                        />
                    </Field>
                    <Field label="Role">
                        <select value={role} onChange={(e) => setRole(e.target.value)}>
                            <option value="reader">Reader</option>
                            <option value="publisher">Publisher</option>
                            <option value="admin">Administrator</option>
                        </select>
                    </Field>
                    <ErrorNotice error={invite.error} />
                    <div className="form-footer">
                        <button className="button primary" disabled={invite.isPending}>
                            Create invitation
                        </button>
                    </div>
                </form>
            )}
        </Modal>
    );
}
function ServiceForm({ close }: { close: () => void }) {
    const { account } = useWorkspace();
    const [name, setName] = useState(""),
        [role, setRole] = useState("publisher");
    const create = useAction(
        () =>
            api(`/api/accounts/${account.slug}/services`, serviceAccountSchema, "POST", {
                name,
                role,
            }),
        close,
    );
    return (
        <Modal title="Create a service account" onClose={close}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                }}
            >
                <Field label="Name">
                    <input
                        required
                        maxLength={100}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Release pipeline"
                    />
                </Field>
                <Field label="Maximum role">
                    <select value={role} onChange={(e) => setRole(e.target.value)}>
                        <option value="publisher">Publisher</option>
                        <option value="reader">Reader</option>
                    </select>
                </Field>
                <p className="muted">
                    Create a scoped access token for this identity after saving.
                </p>
                <ErrorNotice error={create.error} />
                <div className="form-footer">
                    <button className="button primary" disabled={create.isPending}>
                        Create service account
                    </button>
                </div>
            </form>
        </Modal>
    );
}
export function Audit() {
    const { account } = useWorkspace(),
        events = useApi(`/api/accounts/${account.slug}/audit`, z.array(auditSchema));
    return (
        <>
            <PageTitle
                eyebrow={account.name}
                title="Activity"
                description="A clear record of what changed, and who changed it."
            />
            <ErrorNotice error={events.error} />
            <section className="panel">
                {events.isPending ? (
                    <Loading />
                ) : events.data?.length ? (
                    <div className="activity-list">
                        {events.data.map((event) => (
                            <div className="activity-item" key={event.id}>
                                <span className="activity-icon">
                                    <Activity size={17} />
                                </span>
                                <div>
                                    <strong>{event.action.replaceAll(".", " ")}</strong>
                                    <span className="mono small-text muted block">
                                        {event.target}
                                    </span>
                                    <small className="muted">{event.actor}</small>
                                </div>
                                <time>{date(event.createdAt)}</time>
                            </div>
                        ))}
                    </div>
                ) : (
                    <Empty title="A fresh start">
                        Publications and administrative changes will appear here.
                    </Empty>
                )}
            </section>
        </>
    );
}
export function AccountSettings() {
    const { account, user } = useWorkspace();
    const [quota, setQuota] = useState(account.maxBytes / 2 ** 30),
        [suspended, setSuspended] = useState(account.suspended);
    const save = useAction(() =>
        api(`/api/admin/accounts/${account.id}`, ok, "PATCH", {
            maxBytes: Math.round(quota * 2 ** 30),
            suspended,
        }),
    );
    const used = account.usedBytes + account.reservedBytes,
        percent = Math.min(100, (used / account.maxBytes) * 100);
    return (
        <>
            <PageTitle
                eyebrow={account.name}
                title="Workspace settings"
                description="A little housekeeping for your registry."
            />
            <section className="panel settings-panel">
                <h2>Storage</h2>
                <div className="storage-heading">
                    <strong>
                        {bytes(used)} <span className="muted">of {bytes(account.maxBytes)}</span>
                    </strong>
                    <Badge>{percent.toFixed(1)}% used</Badge>
                </div>
                <progress max={account.maxBytes} value={used} />
                <p className="muted">
                    {bytes(account.usedBytes)} published · {bytes(account.reservedBytes)} reserved
                    for uploads
                </p>
                {user?.admin && (
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            save.mutate();
                        }}
                    >
                        <Field label="Storage quota (GiB)">
                            <input
                                type="number"
                                min={0.01}
                                step={0.01}
                                value={quota}
                                onChange={(e) => setQuota(Number(e.target.value))}
                                required
                            />
                        </Field>
                        <label className="checkbox-field">
                            <input
                                type="checkbox"
                                checked={suspended}
                                onChange={(e) => setSuspended(e.target.checked)}
                            />{" "}
                            Suspend access to this workspace
                        </label>
                        <ErrorNotice error={save.error} />
                        {save.isSuccess && (
                            <p className="success">
                                <Check size={15} /> Settings saved
                            </p>
                        )}
                        <div className="form-footer">
                            <button className="button primary" disabled={save.isPending}>
                                Save changes
                            </button>
                        </div>
                    </form>
                )}
            </section>
            <div className="notice spaced">
                <ShieldCheck size={20} />
                <span>
                    Membership and token permissions apply to all private content. Repository
                    visibility and retention are managed in each repository's settings.
                </span>
            </div>
        </>
    );
}
export function Invite({ user }: { user: { email: string } | null }) {
    const { secret } = useParams();
    const accept = useAction(() => api("/api/invitations/accept", ok, "POST", { secret }));
    return (
        <div className="standalone">
            <PageTitle
                title="You're invited"
                description="Join a workspace and build something together."
            />
            {user ? (
                <>
                    <p>
                        Accept this invitation as <strong>{user.email}</strong>.
                    </p>
                    <ErrorNotice error={accept.error} />
                    {accept.isSuccess ? (
                        <div className="notice">
                            <Check size={20} />
                            <span>
                                You're in. <Link to="/">Open your workspace</Link>
                            </span>
                        </div>
                    ) : (
                        <button
                            className="button primary"
                            disabled={accept.isPending}
                            onClick={() => accept.mutate()}
                        >
                            Accept invitation
                        </button>
                    )}
                </>
            ) : (
                <p>
                    Sign in using the email address that received the invitation, then return to
                    this page.
                </p>
            )}
        </div>
    );
}
