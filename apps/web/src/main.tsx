import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import "./global.css";

if (import.meta.env.DEV) void import("virtual:stylex:runtime");

// Canonicalize "/" and "/#" to "/#/", and old "/console/..." bookmarks to their hash routes.
if (location.pathname !== "/" || !location.hash.startsWith("#/")) {
    const route = location.hash.startsWith("#/")
        ? location.hash.slice(1)
        : (location.pathname.replace(/^\/console(?=\/|$)/, "") || "/") + location.search;
    history.replaceState(null, "", "/#" + route);
}

const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <HashRouter>
                <App />
            </HashRouter>
        </QueryClientProvider>
    </StrictMode>,
);
