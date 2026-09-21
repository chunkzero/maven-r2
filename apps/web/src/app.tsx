import * as stylex from "@stylexjs/stylex";
import { createContext, useContext, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { accountSchema, configSchema, meSchema, type Account } from "@maven-r2/contracts/schemas";
import { api, authClient, useAction, useApi } from "./api";
import { Button, Empty, ErrorNotice, Field, Input, Loading, Modal, Select, ui } from "./components";
import { Repositories, RepositoryBrowser } from "./repositories";
import { Tokens } from "./tokens";
import { Members, Audit, AccountSettings, Invite } from "./settings";
import { colors, fonts } from "./theme.stylex";

const NARROW = "@media (max-width: 640px)";
const styles = stylex.create({
    root: {
        minHeight: "100vh",
        fontFamily: fonts.sans,
        fontSize: 14,
        lineHeight: 1.5,
        color: colors.fg,
        backgroundColor: colors.bg,
        WebkitFontSmoothing: "antialiased",
    },
    topbar: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px 20px",
        paddingBlock: 12,
        paddingInline: { default: 24, [NARROW]: 16 },
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        borderBottomColor: colors.line,
    },
    brand: { fontWeight: 700, color: colors.fg, textDecorationLine: "none" },
    nav: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px" },
    navLink: {
        color: { default: colors.muted, ":hover": colors.fg },
        textDecorationLine: "none",
        paddingBlock: 4,
        borderBottomWidth: 2,
        borderBottomStyle: "solid",
        borderBottomColor: "transparent",
    },
    active: { color: colors.fg, borderBottomColor: colors.fg },
    end: { display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" },
    main: {
        maxWidth: 1040,
        marginInline: "auto",
        padding: { default: 24, [NARROW]: 16 },
        display: "flex",
        flexDirection: "column",
        gap: 16,
    },
});

type User = z.infer<typeof meSchema>["user"];
const Workspace = createContext<{ account: Account; user: User }>({ account: null!, user: null });
export const useWorkspace = () => useContext(Workspace);

export function App() {
    const config = useApi("/api/config", configSchema),
        me = useApi("/api/me", meSchema),
        accounts = useApi("/api/accounts", z.array(accountSchema));
    const [creating, setCreating] = useState(false);
    const signIn = useMutation({
        mutationFn: async (provider: "github" | "oidc") => {
            const result = await authClient.signIn.social({ provider, callbackURL: location.href });
            if (result.error)
                throw new Error(result.error.message ?? "Unable to sign in. Please try again.");
        },
    });
    if (config.isPending || accounts.isPending || me.isPending) return <Loading />;
    if (!config.data || !accounts.data)
        return (
            <main {...stylex.props(styles.root, styles.main)}>
                <ErrorNotice error={config.error ?? accounts.error ?? me.error} />
                <Button onClick={() => location.reload()}>Try again</Button>
            </main>
        );
    const user = me.data?.user ?? null;
    const home = accounts.data[0] ? `/${accounts.data[0].slug}` : null;
    const create =
        user &&
        config.data.instanceMode === "multi" &&
        (config.data.allowAccountCreation || user.admin)
            ? () => setCreating(true)
            : undefined;
    const provider = config.data.githubEnabled ? "github" : config.data.oidcEnabled ? "oidc" : null;
    return (
        <div {...stylex.props(styles.root)}>
            <header {...stylex.props(styles.topbar)}>
                <Link to="/" {...stylex.props(styles.brand)}>
                    Maven R2
                </Link>
                <Routes>
                    <Route path="/invite/*" element={null} />
                    <Route
                        path="/:account/*"
                        element={<Nav accounts={accounts.data} onCreate={create} />}
                    />
                    <Route path="*" element={null} />
                </Routes>
                <div {...stylex.props(styles.end)}>
                    <a
                        href="https://github.com/chunkzero/maven-r2#publishing"
                        target="_blank"
                        rel="noreferrer"
                        {...stylex.props(ui.quietLink)}
                    >
                        Docs
                    </a>
                    {user ? (
                        <>
                            <span {...stylex.props(ui.muted)}>{user.name}</span>
                            <Button
                                small
                                onClick={async () => {
                                    await authClient.signOut();
                                    history.replaceState(null, "", "/#/");
                                    location.reload();
                                }}
                            >
                                Sign out
                            </Button>
                        </>
                    ) : (
                        provider && (
                            <Button
                                small
                                primary
                                disabled={signIn.isPending}
                                onClick={() => signIn.mutate(provider)}
                            >
                                {provider === "github" ? "Sign in with GitHub" : "Sign in"}
                            </Button>
                        )
                    )}
                </div>
            </header>
            <main {...stylex.props(styles.main)}>
                <ErrorNotice error={signIn.error} />
                <Routes>
                    <Route
                        path="/"
                        element={
                            home ? (
                                <Navigate to={home} replace />
                            ) : (
                                <>
                                    <h1 {...stylex.props(ui.h1)}>Maven R2</h1>
                                    <p {...stylex.props(ui.p, ui.muted)}>
                                        {user
                                            ? "You are not a member of any workspace yet. Create one or accept an invitation."
                                            : "Sign in to see your workspaces. Public repositories are listed without signing in."}
                                    </p>
                                    {create && (
                                        <div>
                                            <Button primary onClick={create}>
                                                Create workspace
                                            </Button>
                                        </div>
                                    )}
                                </>
                            )
                        }
                    />
                    <Route path="/invite/:secret" element={<Invite user={user} />} />
                    <Route
                        path="/:account/*"
                        element={<AccountRoutes accounts={accounts.data} user={user} />}
                    />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </main>
            {creating && <CreateAccount close={() => setCreating(false)} />}
        </div>
    );
}

function Nav({ accounts, onCreate }: { accounts: Account[]; onCreate?: () => void }) {
    const { account: slug = "" } = useParams(),
        navigate = useNavigate();
    const account = accounts.find((account) => account.slug === slug);
    if (!account) return null;
    const admin = account.role === "owner" || account.role === "admin";
    const link = ({ isActive }: { isActive: boolean }) =>
        stylex.props(styles.navLink, isActive && styles.active).className ?? "";
    return (
        <nav {...stylex.props(styles.nav)}>
            {(accounts.length > 1 || onCreate) && (
                <Select
                    sx={ui.auto}
                    aria-label="Workspace"
                    value={slug}
                    onChange={(e) => navigate(`/${e.target.value}`)}
                >
                    {accounts.map((account) => (
                        <option key={account.id} value={account.slug}>
                            {account.name}
                        </option>
                    ))}
                </Select>
            )}
            {onCreate && (
                <Button small onClick={onCreate}>
                    New workspace
                </Button>
            )}
            <NavLink to={`/${slug}`} end className={link}>
                Repositories
            </NavLink>
            {account.role && (
                <NavLink to={`/${slug}/tokens`} className={link}>
                    Tokens
                </NavLink>
            )}
            {admin && (
                <>
                    <NavLink to={`/${slug}/members`} className={link}>
                        Members
                    </NavLink>
                    <NavLink to={`/${slug}/audit`} className={link}>
                        Activity
                    </NavLink>
                    <NavLink to={`/${slug}/settings`} className={link}>
                        Settings
                    </NavLink>
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
            <Empty>
                This workspace is unavailable. Sign in with an account that has access, or choose
                another workspace.
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
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        maxLength={100}
                    />
                </Field>
                <Field label="URL slug" hint="Lowercase letters, numbers, and hyphens.">
                    <Input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        required
                        pattern="[a-z0-9][a-z0-9-]{0,62}"
                    />
                </Field>
                <ErrorNotice error={create.error} />
                <div {...stylex.props(ui.footer)}>
                    <Button type="button" onClick={close}>
                        Cancel
                    </Button>
                    <Button primary disabled={create.isPending}>
                        Create workspace
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
