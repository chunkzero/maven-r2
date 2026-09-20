import { useState } from "react";
import { Link, useParams } from "react-router";
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
    Confirm,
    date,
    Empty,
    ErrorNotice,
    Field,
    Loading,
    Modal,
    PageHeader,
} from "./components";

export function Members() {
    const { account } = useWorkspace(),
        base = `/api/accounts/${account.slug}`;
    const members = useApi(base + "/members", z.array(memberSchema)),
        services = useApi(base + "/services", z.array(serviceAccountSchema)),
        invitations = useApi(base + "/invitations", z.array(invitationSchema));
    const [inviting, setInviting] = useState(false),
        [adding, setAdding] = useState(false),
        [removing, setRemoving] = useState<{
            kind: "members" | "services";
            id: string;
            name: string;
        } | null>(null);
    const remove = useAction(
        () => api(`${base}/${removing!.kind}/${removing!.id}`, ok, "DELETE"),
        () => setRemoving(null),
    );
    const revoke = useAction((id: string) => api(`${base}/invitations/${id}`, ok, "DELETE"));
    const changeRole = useAction(({ id, role }: { id: string; role: string }) =>
        api(`${base}/members/${id}`, ok, "PATCH", { role }),
    );
    const [now] = useState(Date.now);
    return (
        <>
            <PageHeader title="Members">
                <button className="button primary" onClick={() => setInviting(true)}>
                    Invite member
                </button>
            </PageHeader>
            <ErrorNotice error={members.error ?? changeRole.error} />
            {members.isPending ? (
                <Loading />
            ) : members.data?.length ? (
                <div className="scroll">
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
                                        <strong>{member.name}</strong>{" "}
                                        <span className="muted">{member.email}</span>
                                    </td>
                                    <td>
                                        {member.role === "owner" ? (
                                            "owner"
                                        ) : (
                                            <select
                                                aria-label={`Role for ${member.name}`}
                                                value={member.role}
                                                disabled={changeRole.isPending}
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
                                                    ...(account.role === "owner" ? ["owner"] : []),
                                                ].map((role) => (
                                                    <option key={role} value={role}>
                                                        {role}
                                                    </option>
                                                ))}
                                            </select>
                                        )}
                                    </td>
                                    <td>
                                        <button
                                            className="button small danger"
                                            aria-label={`Remove ${member.name}`}
                                            onClick={() =>
                                                setRemoving({
                                                    kind: "members",
                                                    id: member.userId,
                                                    name: member.name,
                                                })
                                            }
                                        >
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <Empty>No members yet.</Empty>
            )}
            <section>
                <div className="page-header">
                    <h2>Service accounts</h2>
                    <button className="button" onClick={() => setAdding(true)}>
                        New service account
                    </button>
                </div>
                <ErrorNotice error={services.error} />
                {services.data?.length ? (
                    <div className="scroll">
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
                                            <strong>{service.name}</strong>
                                        </td>
                                        <td>{service.role}</td>
                                        <td>
                                            <Badge tone={service.disabled ? "neutral" : "green"}>
                                                {service.disabled ? "Disabled" : "Active"}
                                            </Badge>
                                        </td>
                                        <td>
                                            {!service.disabled && (
                                                <button
                                                    className="button small danger"
                                                    aria-label={`Disable ${service.name}`}
                                                    onClick={() =>
                                                        setRemoving({
                                                            kind: "services",
                                                            id: service.id,
                                                            name: service.name,
                                                        })
                                                    }
                                                >
                                                    Disable
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <Empty>
                        No service accounts yet. Create one, then issue it a scoped token for CI.
                    </Empty>
                )}
            </section>
            {!!invitations.data?.length && (
                <section>
                    <h2>Invitations</h2>
                    <ErrorNotice error={revoke.error} />
                    <div className="scroll">
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
                                        <td>{invite.role}</td>
                                        <td>
                                            {invite.accepted
                                                ? "Accepted"
                                                : invite.expiresAt < now
                                                  ? "Expired"
                                                  : "Pending"}
                                        </td>
                                        <td className="muted">{date(invite.expiresAt)}</td>
                                        <td>
                                            {!invite.accepted && invite.expiresAt > now && (
                                                <button
                                                    className="button small"
                                                    disabled={revoke.isPending}
                                                    onClick={() => revoke.mutate(invite.id)}
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
                </section>
            )}
            {inviting && <InviteForm close={() => setInviting(false)} />}
            {adding && <ServiceForm close={() => setAdding(false)} />}
            {removing && (
                <Confirm
                    title={
                        removing.kind === "services" ? "Disable service account?" : "Remove member?"
                    }
                    action="Remove access"
                    pending={remove.isPending}
                    error={remove.error}
                    onConfirm={() => remove.mutate()}
                    onClose={() => setRemoving(null)}
                >
                    <strong>{removing.name}</strong> loses access to this workspace and its tokens
                    stop working.
                </Confirm>
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
    if (url)
        return (
            <Modal title="Invitation ready" onClose={close}>
                <p>
                    Send this link to <strong>{email}</strong>. They must sign in with that verified
                    email address. It expires in seven days.
                </p>
                <Code>{url}</Code>
                <div className="form-footer">
                    <button className="button primary" onClick={close}>
                        Done
                    </button>
                </div>
            </Modal>
        );
    return (
        <Modal title="Invite a member" onClose={close}>
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
                    <button type="button" className="button" onClick={close}>
                        Cancel
                    </button>
                    <button className="button primary" disabled={invite.isPending}>
                        Create invitation
                    </button>
                </div>
            </form>
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
                    />
                </Field>
                <Field label="Maximum role">
                    <select value={role} onChange={(e) => setRole(e.target.value)}>
                        <option value="publisher">Publisher</option>
                        <option value="reader">Reader</option>
                    </select>
                </Field>
                <ErrorNotice error={create.error} />
                <div className="form-footer">
                    <button type="button" className="button" onClick={close}>
                        Cancel
                    </button>
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
            <PageHeader title="Activity" />
            <ErrorNotice error={events.error} />
            {events.isPending ? (
                <Loading />
            ) : events.data?.length ? (
                <div className="scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Action</th>
                                <th>Target</th>
                                <th>Actor</th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.data.map((event) => (
                                <tr key={event.id}>
                                    <td className="muted">{date(event.createdAt)}</td>
                                    <td>{event.action}</td>
                                    <td className="mono">{event.target}</td>
                                    <td className="mono muted">{event.actor}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <Empty>No activity yet.</Empty>
            )}
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
    const used = account.usedBytes + account.reservedBytes;
    return (
        <>
            <PageHeader title="Settings" />
            <section>
                <h2>Storage</h2>
                <progress max={account.maxBytes} value={used} />
                <p className="muted">
                    {bytes(account.usedBytes)} stored · {bytes(account.reservedBytes)} staged ·{" "}
                    {bytes(account.maxBytes)} quota
                </p>
            </section>
            {user?.admin && (
                <section>
                    <h2>Instance administration</h2>
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
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={suspended}
                                onChange={(e) => setSuspended(e.target.checked)}
                            />
                            Suspend this workspace
                        </label>
                        <ErrorNotice error={save.error} />
                        <div className="form-footer">
                            {save.isSuccess && <span className="muted">Saved</span>}
                            <button className="button primary" disabled={save.isPending}>
                                Save
                            </button>
                        </div>
                    </form>
                </section>
            )}
        </>
    );
}
export function Invite({ user }: { user: { email: string } | null }) {
    const { secret } = useParams();
    const accept = useAction(() => api("/api/invitations/accept", ok, "POST", { secret }));
    return (
        <>
            <PageHeader title="Workspace invitation" />
            {!user ? (
                <p>Sign in with the email address that received this invitation, then reload.</p>
            ) : accept.isSuccess ? (
                <p>
                    You have joined. <Link to="/">Open your workspace</Link>.
                </p>
            ) : (
                <>
                    <p>
                        Accept this invitation as <strong>{user.email}</strong>.
                    </p>
                    <ErrorNotice error={accept.error} />
                    <button
                        className="button primary"
                        disabled={accept.isPending}
                        onClick={() => accept.mutate()}
                    >
                        Accept invitation
                    </button>
                </>
            )}
        </>
    );
}
