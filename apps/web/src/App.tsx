import {
	createRouter,
	RouterProvider,
	createRootRoute,
	createRoute,
	Outlet,
} from "@tanstack/react-router";
import { DashboardPage } from "./routes/index";
import { LoginPage } from "./routes/login";
import { ObservabilityPage } from "./routes/observability";
import { TraceDetailPage } from "./routes/observability/traces/$id";
import { PromptsPage } from "./routes/prompts";
import { NewPromptPage } from "./routes/prompts-new";
import { PromptDetailPage } from "./routes/prompts-detail";
import { EditPromptPage } from "./routes/prompts-edit";
import { AuthGate } from "./components/AuthGate";
import { AppShell } from "./components/AppShell";
import { ProjectProvider } from "./components/ProjectProvider";

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
			<ProjectProvider>
				<AppShell>
					<Outlet />
				</AppShell>
			</ProjectProvider>
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

const observabilityTraceDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/observability/traces/$id",
	component: TraceDetailPage,
});

const promptsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts",
	component: PromptsPage,
});

const newPromptRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts/new",
	component: NewPromptPage,
});

const promptDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts/$slug",
	component: PromptDetailPage,
});

const promptEditRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts/$slug/edit",
	component: EditPromptPage,
});

const router = createRouter({
	routeTree: rootRoute.addChildren([
		loginRoute,
		protectedRoute.addChildren([
			indexRoute,
			observabilityRoute,
			observabilityTraceDetailRoute,
			promptsRoute,
			newPromptRoute,
			promptDetailRoute,
			promptEditRoute,
		]),
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
