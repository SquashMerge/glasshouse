import { createRouter, RouterProvider, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { DashboardPage } from "./routes/index";
import { LoginPage } from "./routes/login";
import { AuthGate } from "./components/AuthGate";
import { AppShell } from "./components/AppShell";

// Public root route — no shell, no auth gate.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// /login — public.
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

// Protected layout: shell + auth gate. All nested routes get this.
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

// /  — dashboard (protected).
const indexRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/",
  component: DashboardPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([loginRoute, protectedRoute.addChildren([indexRoute])]),
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