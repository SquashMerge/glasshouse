import { createRouter, RouterProvider, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { DashboardPage } from "./routes/index";
import { LoginPage } from "./routes/login";
import { TraceListPage } from "./routes/traces/index";
import { TraceDetailPage } from "./routes/traces/$id";
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

const tracesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/traces",
  component: TraceListPage,
});

const traceDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/traces/$id",
  component: TraceDetailPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    protectedRoute.addChildren([indexRoute, tracesRoute, traceDetailRoute]),
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