import { createContext, useContext, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { accountSchema, configSchema, meSchema, type Account } from "@maven-r2/contracts/schemas";
import { api, authClient, useAction, useApi } from "./api";
import { ErrorNotice, Field, Loading, Modal } from "./components";
import { Repositories, RepositoryBrowser } from "./repositories";
import { Tokens } from "./tokens";
import { Members, Audit, AccountSettings, Invite } from "./settings";

type User = z.infer<typeof meSchema>["user"];
const Workspace = createContext<{ account: Account; user: User }>({ account: null!, user: null });
export const useWorkspace = () => useContext(Workspace);

export function App() {
    const config = useApi("/api/config", configSchema),
        me = useApi("/api/me", meSchema),
        accounts = useApi("/api/accounts", z.array(accountSchema));
    const [creating, setCreating] = useState(false);
    if (config.isPending || accounts.isPending || me.isPending) return <Loading />;
    if (!config.data || !accounts.data)
        return (
            <main>
                <ErrorNotice error={config.error ?? accounts.error ?? me.error} />
                <button className="button" onClick={() => location.reload()}>
                    Try again
                </button>
            </main>
        );
    const user = me.data?.user ?? null;
    const home = accounts.data[0] ? `/${accounts.data[0].slug}` : "/welcome";
    const create =
        user &&
        config.data.instanceMode === "multi" &&
        (config.data.allowAccountCreation || user.admin)
            ? () => setCreating(true)
            : undefined;
    const provider = config.data.githubEnabled ? "github" : config.data.oidcEnabled ? "oidc" : null;
    return (
        <>
            <header className="topbar">
                <Link to={home} className="brand">
                    Maven R2
                </Link>
                <Routes>
                    <Route
                        path="/:account/*"
                        element={<Nav accounts={accounts.data} onCreate={create} />}
                    />
                    <Route path="*" element={null} />
                </Routes>
                <div className="topbar-end">
                    <a
                        href="https://github.com/chunkzero/maven-r2#publishing"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Docs
                    </a>
                    {user ? (
                        <>
                            <span className="muted">{user.name}</span>
                            <button
                                className="button small"
                                onClick={async () => {
                                    await authClient.signOut();
                                    location.assign("/");
                                }}
                            >
                                Sign out
                            </button>
                        </>
                    ) : (
                        provider && (
                            <button
                                className="button small primary"
                                onClick={() =>
                                    void authClient.signIn.social({
                                        provider,
                                        callbackURL: location.href,
                                    })
                                }
                            >
                                {provider === "github" ? "Sign in with GitHub" : "Sign in"}
                            </button>
                        )
                    )}
                </div>
            </header>
            <main>
                <Routes>
                    <Route
                        path="/:account/*"
                        element={<AccountRoutes accounts={accounts.data} user={user} />}
                    />
                    <Route path="/invite/:secret" element={<Invite user={user} />} />
                    <Route
                        path="/welcome"
                        element={
                            <>
                                <h1>Maven R2</h1>
                                <p className="muted">
                                    {user
                                        ? "You are not a member of any workspace yet. Create one or accept an invitation."
                                        : "Sign in to see your workspaces. Public repositories are listed without signing in."}
                                </p>
                                {create && (
                                    <button className="button primary" onClick={create}>
                                        Create workspace
                                    </button>
                                )}
                            </>
                        }
                    />
                    <Route path="*" element={<Navigate to={home} replace />} />
                </Routes>
            </main>
            {creating && <CreateAccount close={() => setCreating(false)} />}
        </>
    );
}

function Nav({ accounts, onCreate }: { accounts: Account[]; onCreate?: () => void }) {
    const { account: slug = "" } = useParams(),
        navigate = useNavigate();
    const account = accounts.find((account) => account.slug === slug),
        base = `/${slug}`;
    const admin = account?.role === "owner" || account?.role === "admin";
    return (
        <nav className="nav">
            {(accounts.length > 1 || onCreate) && (
                <select
                    aria-label="Workspace"
                    value={slug}
                    onChange={(e) => navigate(`/${e.target.value}`)}
                >
                    {accounts.map((account) => (
                        <option key={account.id} value={account.slug}>
                            {account.name}
                        </option>
                    ))}
                </select>
            )}
            {onCreate && (
                <button className="button small" onClick={onCreate}>
                    New workspace
                </button>
            )}
            <NavLink to={base} end>
                Repositories
            </NavLink>
            {account?.role && <NavLink to={base + "/tokens"}>Tokens</NavLink>}
            {admin && (
                <>
                    <NavLink to={base + "/members"}>Members</NavLink>
                    <NavLink to={base + "/audit"}>Activity</NavLink>
                    <NavLink to={base + "/settings"}>Settings</NavLink>
                </>
            )}
        </nav>
    );
}
function AccountRoutes({ accounts, user }: { accounts: Account[]; user: User }) {
    const { account: slug } = useParams(),
        account = accounts.find((account) => account.slug === slug);
    if (!account)
        return (
            <p className="empty">
                This workspace is unavailable. Sign in with an account that has access, or choose
                another workspace.
            </p>
        );
    return (
        <Workspace.Provider value={{ account, user }}>
            <Routes>
                <Route index element={<Repositories />} />
                <Route path="repositories/:repository" element={<RepositoryBrowser />} />
                <Route path="tokens" element={<Tokens />} />
                <Route path="members" element={<Members />} />
                <Route path="audit" element={<Audit />} />
                <Route path="settings" element={<AccountSettings />} />
                <Route path="*" element={<Navigate to={`/${account.slug}`} replace />} />
            </Routes>
        </Workspace.Provider>
    );
}
function CreateAccount({ close }: { close: () => void }) {
    const [name, setName] = useState(""),
        [slug, setSlug] = useState("");
    const navigate = useNavigate();
    const create = useAction(
        () => api("/api/accounts", accountSchema, "POST", { name, slug }),
        () => {
            close();
            navigate(`/${slug}`);
        },
    );
    return (
        <Modal title="Create a workspace" onClose={close}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
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
                <Field label="URL slug" hint="Lowercase letters, numbers, and hyphens.">
                    <input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        required
                        pattern="[a-z0-9][a-z0-9-]{0,62}"
                    />
                </Field>
                <ErrorNotice error={create.error} />
                <div className="form-footer">
                    <button className="button" type="button" onClick={close}>
                        Cancel
                    </button>
                    <button className="button primary" disabled={create.isPending}>
                        Create workspace
                    </button>
                </div>
            </form>
        </Modal>
    );
}
