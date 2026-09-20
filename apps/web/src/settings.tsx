import * as stylex from "@stylexjs/stylex";
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
    const roles = ["reader", "publisher", "admin", ...(account.role === "owner" ? ["owner"] : [])];
    return (
        <>
            <PageHeader title="Members">
                <Button primary onClick={() => setInviting(true)}>
                    Invite member
                </Button>
            </PageHeader>
            <ErrorNotice error={members.error ?? changeRole.error} />
            {members.isPending ? (
                <Loading />
            ) : members.data?.length ? (
                <Table head={["Member", "Role", ""]}>
                    {members.data.map((member) => (
                        <tr key={member.userId}>
                            <Td>
                                <strong>{member.name}</strong>{" "}
                                <span {...stylex.props(ui.muted)}>{member.email}</span>
                            </Td>
                            <Td>
                                {member.role === "owner" && account.role !== "owner" ? (
                                    "owner"
                                ) : (
                                    <Select
                                        sx={ui.auto}
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
                                        {roles.map((role) => (
                                            <option key={role} value={role}>
                                                {role}
                                            </option>
                                        ))}
                                    </Select>
                                )}
                            </Td>
                            <Td right>
                                <Button
                                    small
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
                                </Button>
                            </Td>
                        </tr>
                    ))}
                </Table>
            ) : (
                <Empty>No members yet.</Empty>
            )}
            <section>
                <div {...stylex.props(ui.pageHeader)}>
                    <h2 {...stylex.props(ui.h2)}>Service accounts</h2>
                    <Button onClick={() => setAdding(true)}>New service account</Button>
                </div>
                <ErrorNotice error={services.error} />
                {services.data?.length ? (
                    <Table head={["Service", "Role", "Status", ""]}>
                        {services.data.map((service) => (
                            <tr key={service.id}>
                                <Td>
                                    <strong>{service.name}</strong>
                                </Td>
                                <Td>{service.role}</Td>
                                <Td>{service.disabled ? "Disabled" : "Active"}</Td>
                                <Td right>
                                    {!service.disabled && (
                                        <Button
                                            small
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
                                        </Button>
                                    )}
                                </Td>
                            </tr>
                        ))}
                    </Table>
                ) : (
                    <Empty>
                        No service accounts yet. Create one, then issue it a scoped token for CI.
                    </Empty>
                )}
            </section>
            {!!invitations.data?.length && (
                <section>
                    <h2 {...stylex.props(ui.h2)}>Invitations</h2>
                    <ErrorNotice error={revoke.error} />
                    <Table head={["Email", "Role", "Status", "Expires", ""]}>
                        {invitations.data.map((invite) => (
                            <tr key={invite.id}>
                                <Td>{invite.email}</Td>
                                <Td>{invite.role}</Td>
                                <Td>
                                    {invite.accepted
                                        ? "Accepted"
                                        : invite.expiresAt < now
                                          ? "Expired"
                                          : "Pending"}
                                </Td>
                                <Td muted>{date(invite.expiresAt)}</Td>
                                <Td right>
                                    {!invite.accepted && invite.expiresAt > now && (
                                        <Button
                                            small
                                            disabled={revoke.isPending}
                                            onClick={() => revoke.mutate(invite.id)}
                                        >
                                            Revoke
                                        </Button>
                                    )}
                                </Td>
                            </tr>
                        ))}
                    </Table>
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
                <p {...stylex.props(ui.p)}>
                    Send this link to <strong>{email}</strong>. They must sign in with that verified
                    email address. It expires in seven days.
                </p>
                <Code>{url}</Code>
                <div {...stylex.props(ui.footer)}>
                    <Button primary onClick={close}>
                        Done
                    </Button>
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
                    <Input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                </Field>
                <Field label="Role">
                    <Select value={role} onChange={(e) => setRole(e.target.value)}>
                        <option value="reader">Reader</option>
                        <option value="publisher">Publisher</option>
                        <option value="admin">Administrator</option>
                    </Select>
                </Field>
                <ErrorNotice error={invite.error} />
                <div {...stylex.props(ui.footer)}>
                    <Button type="button" onClick={close}>
                        Cancel
                    </Button>
                    <Button primary disabled={invite.isPending}>
                        Create invitation
                    </Button>
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
                    <Input
                        required
                        maxLength={100}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </Field>
                <Field label="Maximum role">
                    <Select value={role} onChange={(e) => setRole(e.target.value)}>
                        <option value="publisher">Publisher</option>
                        <option value="reader">Reader</option>
                    </Select>
                </Field>
                <ErrorNotice error={create.error} />
                <div {...stylex.props(ui.footer)}>
                    <Button type="button" onClick={close}>
                        Cancel
                    </Button>
                    <Button primary disabled={create.isPending}>
                        Create service account
                    </Button>
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
                <Table head={["When", "Action", "Target", "Actor"]}>
                    {events.data.map((event) => (
                        <tr key={event.id}>
                            <Td muted>{date(event.createdAt)}</Td>
                            <Td>{event.action}</Td>
                            <Td>
                                <span {...stylex.props(ui.mono)}>{event.target}</span>
                            </Td>
                            <Td muted>
                                <span {...stylex.props(ui.mono)}>{event.actor}</span>
                            </Td>
                        </tr>
                    ))}
                </Table>
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
                <h2 {...stylex.props(ui.h2)}>Storage</h2>
                <progress {...stylex.props(ui.progress)} max={account.maxBytes} value={used} />
                <p {...stylex.props(ui.p, ui.muted)}>
                    {bytes(account.usedBytes)} stored · {bytes(account.reservedBytes)} staged ·{" "}
                    {bytes(account.maxBytes)} quota
                </p>
            </section>
            {user?.admin && (
                <section>
                    <h2 {...stylex.props(ui.h2)}>Instance administration</h2>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            save.mutate();
                        }}
                    >
                        <Field label="Storage quota (GiB)">
                            <Input
                                type="number"
                                min={0.01}
                                step={0.01}
                                value={quota}
                                onChange={(e) => setQuota(Number(e.target.value))}
                                required
                            />
                        </Field>
                        <label {...stylex.props(ui.check)}>
                            <input
                                type="checkbox"
                                checked={suspended}
                                onChange={(e) => setSuspended(e.target.checked)}
                            />
                            Suspend this workspace
                        </label>
                        <ErrorNotice error={save.error} />
                        <div {...stylex.props(ui.footer)}>
                            {save.isSuccess && <span {...stylex.props(ui.muted)}>Saved</span>}
                            <Button primary disabled={save.isPending}>
                                Save
                            </Button>
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
                <p {...stylex.props(ui.p)}>
                    Sign in with the email address that received this invitation, then reload.
                </p>
            ) : accept.isSuccess ? (
                <p {...stylex.props(ui.p)}>
                    You have joined.{" "}
                    <Link to="/" {...stylex.props(ui.link)}>
                        Open your workspace
                    </Link>
                    .
                </p>
            ) : (
                <>
                    <p {...stylex.props(ui.p)}>
                        Accept this invitation as <strong>{user.email}</strong>.
                    </p>
                    <ErrorNotice error={accept.error} />
                    <div>
                        <Button primary disabled={accept.isPending} onClick={() => accept.mutate()}>
                            Accept invitation
                        </Button>
                    </div>
                </>
            )}
        </>
    );
}
