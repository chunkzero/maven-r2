import { createContext, useContext, useState } from "react";
import {
    Link,
    NavLink,
    Navigate,
    Route,
    Routes,
    useNavigate,
    useLocation,
    useParams,
} from "react-router";
import {
    Activity,
    ArrowUpRight,
    Box,
    ChevronDown,
    FolderGit2,
    KeyRound,
    LogOut,
    Moon,
    Plus,
    Settings2,
    Sun,
    Users,
    Terminal,
    Menu,
    X,
} from "lucide-react";
import { z } from "zod";
import { accountSchema, configSchema, meSchema, type Account } from "@maven-r2/contracts/schemas";
import { api, authClient, useAction, useApi } from "./api";
import { Code, Empty, ErrorNotice, Field, Loading, Modal } from "./components";
import { Repositories, RepositoryBrowser } from "./repositories";
import { Tokens } from "./tokens";
import { Members, Audit, AccountSettings, Invite } from "./settings";

type Session = z.infer<typeof meSchema>["user"];
const Workspace = createContext<{ account: Account; user: Session }>({
    account: null!,
    user: null,
});
export const useWorkspace = () => useContext(Workspace);

export function App() {
    const config = useApi("/api/config", configSchema),
        me = useApi("/api/me", meSchema),
        accounts = useApi("/api/accounts", z.array(accountSchema));
    const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
    const [creating, setCreating] = useState(false),
        [help, setHelp] = useState(false),
        [mobile, setMobile] = useState(false);
    const navigate = useNavigate(),
        route = useLocation();
    const user = me.data?.user ?? null;
    const toggleTheme = () => {
        const value = !dark;
        setDark(value);
        localStorage.setItem("theme", value ? "dark" : "light");
    };
    if (config.isPending || accounts.isPending || me.isPending) return <Loading />;
    const error = config.error ?? accounts.error ?? me.error;
    if (error)
        return (
            <div className="standalone">
                <ErrorNotice error={error} />
                <button className="button" onClick={() => location.reload()}>
                    Try again
                </button>
            </div>
        );
    const login = () =>
        authClient.signIn.social({ provider: "github", callbackURL: location.href });
    const defaultPath = accounts.data?.[0] ? `/a/${accounts.data[0].slug}` : "/welcome";
    return (
        <div className={`app ${dark ? "dark" : ""}`}>
            <aside className={`sidebar ${mobile ? "visible" : ""}`}>
                <Link to={defaultPath} className="brand">
                    <span className="brand-mark">
                        <Box size={23} />
                    </span>
                    <span>
                        maven<span className="brand-suffix">r2</span>
                    </span>
                    <span className="edition">BETA</span>
                </Link>
                <div className="workspace-picker">
                    <label htmlFor="workspace">WORKSPACE</label>
                    <div>
                        <select
                            id="workspace"
                            aria-label="Select workspace"
                            value={route.pathname.split("/")[2] ?? accounts.data?.[0]?.slug ?? ""}
                            onChange={(e) => navigate(`/a/${e.target.value}`)}
                        >
                            {accounts.data?.map((account) => (
                                <option key={account.id} value={account.slug}>
                                    {account.name}
                                </option>
                            ))}
                            {!accounts.data?.length && <option>No workspace</option>}
                        </select>
                        <ChevronDown size={15} />
                    </div>
                </div>
                <Routes>
                    <Route
                        path="/a/:account/*"
                        element={
                            <Sidebar
                                accounts={accounts.data ?? []}
                                onNavigate={() => setMobile(false)}
                            />
                        }
                    />
                    <Route
                        path="*"
                        element={<div className="sidebar-caption">Your packages. Your space.</div>}
                    />
                </Routes>
                {user &&
                    config.data?.instanceMode === "multi" &&
                    (config.data.allowAccountCreation || user.admin) && (
                        <button className="sidebar-link" onClick={() => setCreating(true)}>
                            <Plus size={17} />
                            New workspace
                        </button>
                    )}
                <div className="sidebar-bottom">
                    <div className="sidebar-card">
                        <span className="status-dot" />
                        <strong>A home for your artifacts.</strong>
                        <p>
                            Simple publishing.
                            <br />
                            Storage that grows with you.
                        </p>
                        <button onClick={() => setHelp(true)}>
                            Publishing guide <ArrowUpRight size={14} />
                        </button>
                    </div>
                    <div className="sidebar-footer">
                        <span>Built on Cloudflare R2</span>
                        <button
                            className="icon-button"
                            aria-label={dark ? "Use light theme" : "Use dark theme"}
                            onClick={toggleTheme}
                        >
                            {dark ? <Sun size={17} /> : <Moon size={17} />}
                        </button>
                    </div>
                </div>
            </aside>
            <div className="main-shell">
                <div className="topbar">
                    <button
                        className="icon-button mobile-menu"
                        aria-label="Toggle navigation"
                        onClick={() => setMobile(!mobile)}
                    >
                        {mobile ? <X size={20} /> : <Menu size={20} />}
                    </button>
                    <span className="topbar-label">ARTIFACT REGISTRY</span>
                    <div className="topbar-actions">
                        <button className="button subtle small" onClick={() => setHelp(true)}>
                            <Terminal size={15} /> Quick start
                        </button>
                        {user ? (
                            <>
                                <div className="avatar">{user.name.slice(0, 2).toUpperCase()}</div>
                                <span className="user-name">{user.name}</span>
                                <button
                                    className="icon-button"
                                    aria-label="Sign out"
                                    onClick={async () => {
                                        await authClient.signOut();
                                        location.assign("/");
                                    }}
                                >
                                    <LogOut size={16} />
                                </button>
                            </>
                        ) : config.data?.githubEnabled ? (
                            <button className="button small" onClick={() => void login()}>
                                Sign in with GitHub <ArrowUpRight size={14} />
                            </button>
                        ) : config.data?.oidcEnabled ? (
                            <button
                                className="button small"
                                onClick={() =>
                                    void authClient.signIn.social({
                                        provider: "oidc",
                                        callbackURL: location.href,
                                    })
                                }
                            >
                                Sign in
                            </button>
                        ) : (
                            <span className="muted small-text">Public access</span>
                        )}
                    </div>
                </div>
                <main>
                    <Routes>
                        <Route
                            path="/a/:account/*"
                            element={<AccountRoutes accounts={accounts.data ?? []} user={user} />}
                        />
                        <Route path="/invite/:secret" element={<Invite user={user} />} />
                        <Route
                            path="/tokens"
                            element={
                                <Navigate
                                    to={
                                        defaultPath === "/welcome"
                                            ? defaultPath
                                            : defaultPath + "/tokens"
                                    }
                                    replace
                                />
                            }
                        />
                        <Route
                            path="/welcome"
                            element={
                                <div className="welcome">
                                    <div className="eyebrow">MAVEN R2</div>
                                    <h1>
                                        Your artifacts,
                                        <br />
                                        at home.
                                    </h1>
                                    <p>A quiet, reliable place for the packages you build.</p>
                                    <Empty
                                        title={
                                            user ? "No workspaces yet" : "Welcome to your registry"
                                        }
                                    >
                                        {user
                                            ? "Create a workspace or accept an invitation to get started."
                                            : "Public repositories will appear here. Sign in to access your private workspaces."}
                                    </Empty>
                                    {user && config.data?.allowAccountCreation && (
                                        <button
                                            className="button primary"
                                            onClick={() => setCreating(true)}
                                        >
                                            Create workspace
                                        </button>
                                    )}
                                </div>
                            }
                        />
                        <Route path="*" element={<Navigate to={defaultPath} replace />} />
                    </Routes>
                </main>
                <footer className="main-footer">
                    <span>Maven R2</span>
                    <span>Built for the things you build.</span>
                </footer>
            </div>
            {creating && <CreateAccount close={() => setCreating(false)} />}
            {help && (
                <Modal title="Publish your first package" onClose={() => setHelp(false)}>
                    <p className="muted">
                        Create a scoped token in your workspace, then configure your build to use
                        the local proxy.
                    </p>
                    <ol className="steps">
                        <li>
                            <strong>Connect your instance</strong>
                            <Code>{`maven-r2 login --server ${location.origin}`}</Code>
                        </li>
                        <li>
                            <strong>Point your build at the proxy</strong>
                            <p>
                                Use <code>MAVEN_R2_URL</code>, <code>MAVEN_R2_USERNAME</code>, and{" "}
                                <code>MAVEN_R2_PASSWORD</code> from the environment for your
                                publishing repository.
                            </p>
                        </li>
                        <li>
                            <strong>Publish</strong>
                            <Code>{`maven-r2 publish --repository ${accounts.data?.[0]?.slug ?? "account"}/releases -- ./gradlew publish`}</Code>
                            <p>
                                Your release becomes available when the build and validation
                                succeed.
                            </p>
                        </li>
                    </ol>
                    <a
                        className="text-link"
                        href="https://github.com/chunkzero/maven-r2#publishing"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Full Maven and Gradle setup <ArrowUpRight size={14} />
                    </a>
                </Modal>
            )}
        </div>
    );
}

function Sidebar({ accounts, onNavigate }: { accounts: Account[]; onNavigate: () => void }) {
    const { account: slug } = useParams(),
        account = accounts.find((account) => account.slug === slug),
        base = `/a/${slug}`;
    const admin = account?.role === "owner" || account?.role === "admin";
    const links = [
        { path: base, label: "Repositories", icon: FolderGit2, end: true },
        ...(account?.role
            ? [{ path: base + "/tokens", label: "Access tokens", icon: KeyRound, end: false }]
            : []),
        ...(admin
            ? [
                  { path: base + "/members", label: "Members & services", icon: Users, end: false },
                  { path: base + "/audit", label: "Activity", icon: Activity, end: false },
                  {
                      path: base + "/settings",
                      label: "Workspace settings",
                      icon: Settings2,
                      end: false,
                  },
              ]
            : []),
    ];
    return (
        <nav>
            {links.map(({ path, label, icon: Icon, end }) => (
                <NavLink
                    key={path}
                    to={path}
                    end={end}
                    className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
                    onClick={onNavigate}
                >
                    <Icon size={18} />
                    {label}
                </NavLink>
            ))}
        </nav>
    );
}
function AccountRoutes({ accounts, user }: { accounts: Account[]; user: Session }) {
    const { account: slug } = useParams(),
        account = accounts.find((account) => account.slug === slug);
    if (!account)
        return (
            <Empty title="Workspace unavailable">
                Sign in with an account that has access, or choose another workspace.
            </Empty>
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
                <Route path="*" element={<Navigate to={`/a/${account.slug}`} replace />} />
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
            navigate(`/a/${slug}`);
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
                        placeholder="Acme Engineering"
                    />
                </Field>
                <Field label="URL slug" hint="Lowercase letters, numbers, and hyphens.">
                    <input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        required
                        pattern="[a-z0-9][a-z0-9-]{0,62}"
                        placeholder="acme"
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
