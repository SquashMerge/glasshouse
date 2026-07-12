import { createRouter, RouterProvider, createRootRoute, createRoute, Outlet, redirect } from "@tanstack/react-router";
import { DashboardPage } from "./routes/index";
import { LoginPage } from "./routes/login";
import { TraceListPage } from "./routes/traces/index";
import { TraceDetailPage } from "./routes/traces/$id";
import { ObservabilityPage } from "./routes/observability";
import { AuthGate } from "./components/AuthGate";
import { AppShell } from "./components/AppShell";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected",
  component: () => (
    <AuthGate>
      <AppShell>
        <Outlet />
      </AppShell>
    </AuthGate>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/",
  component: DashboardPage,
});

const observabilityRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/observability",
  component: ObservabilityPage,
});

const tracesRedirectRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/traces",
  beforeLoad: () => {
    throw redirect({ to: "/observability", search: { tab: "traces" } });
  },
});

const traceDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/traces/$id",
  component: TraceDetailPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    protectedRoute.addChildren([indexRoute, observabilityRoute, tracesRedirectRoute, traceDetailRoute]),
  ]),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}