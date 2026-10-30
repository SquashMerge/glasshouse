import {
	createRouter,
	RouterProvider,
	createRootRoute,
	createRoute,
	Outlet,
	lazyRouteComponent,
} from "@tanstack/react-router";
import { AuthGate } from "./components/AuthGate";
import { AppShell } from "./components/AppShell";
import { ProjectProvider } from "./components/ProjectProvider";

const rootRoute = createRootRoute({
	component: () => <Outlet />,
});

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	component: lazyRouteComponent(() => import("./routes/login"), "LoginPage"),
});
const setupRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/setup",
	component: lazyRouteComponent(() => import("./routes/setup"), "SetupPage"),
});
const enrollmentRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/enroll",
	component: lazyRouteComponent(
		() => import("./routes/enroll"),
		"EnrollmentPage",
	),
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
	component: lazyRouteComponent(
		() => import("./routes/index"),
		"DashboardPage",
	),
});

const observabilityRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/observability",
	component: lazyRouteComponent(
		() => import("./routes/observability"),
		"ObservabilityPage",
	),
});

const observabilityTraceDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/observability/traces/$id",
	component: lazyRouteComponent(
		() => import("./routes/observability/traces/$id"),
		"TraceDetailPage",
	),
});

const promptsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts",
	component: lazyRouteComponent(
		() => import("./routes/prompts"),
		"PromptsPage",
	),
});

const newPromptRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts/new",
	component: lazyRouteComponent(
		() => import("./routes/prompts-new"),
		"NewPromptPage",
	),
});

const promptDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts/$slug",
	component: lazyRouteComponent(
		() => import("./routes/prompts-detail"),
		"PromptDetailPage",
	),
});

const promptEditRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/prompts/$slug/edit",
	component: lazyRouteComponent(
		() => import("./routes/prompts-edit"),
		"EditPromptPage",
	),
});
const datasetsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/datasets",
	component: lazyRouteComponent(
		() => import("./routes/datasets"),
		"DatasetsPage",
	),
});
const datasetDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/datasets/$id",
	component: lazyRouteComponent(
		() => import("./routes/datasets"),
		"DatasetDetailPage",
	),
});
const evaluationsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/evaluations",
	component: lazyRouteComponent(
		() => import("./routes/evaluations"),
		"EvaluationsPage",
	),
});
const evaluationDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/evaluation-definitions/$slug",
	component: lazyRouteComponent(
		() => import("./routes/evaluations"),
		"EvaluationDefinitionDetailPage",
	),
});
const evaluationRunDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/evaluations/$id",
	component: lazyRouteComponent(
		() => import("./routes/evaluations"),
		"EvaluationDetailPage",
	),
});
const feedbackRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/feedback",
	component: lazyRouteComponent(
		() => import("./routes/feedback"),
		"FeedbackPage",
	),
});
const projectsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/projects",
	component: lazyRouteComponent(
		() => import("./routes/projects"),
		"ProjectsPage",
	),
});
const governanceRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/governance",
	component: lazyRouteComponent(
		() => import("./routes/governance"),
		"GovernancePage",
	),
});
const adminAccessRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/access",
	component: lazyRouteComponent(
		() => import("./routes/admin-access"),
		"AdminAccessPage",
	),
});
const passwordChangeRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/account/password",
	component: lazyRouteComponent(
		() => import("./routes/password-change"),
		"PasswordChangePage",
	),
});
const otlpCredentialsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/ingestion-credentials",
	component: lazyRouteComponent(
		() => import("./routes/otlp-credentials"),
		"OtlpCredentialsPage",
	),
});

const router = createRouter({
	routeTree: rootRoute.addChildren([
		loginRoute,
		setupRoute,
		enrollmentRoute,
		protectedRoute.addChildren([
			indexRoute,
			observabilityRoute,
			observabilityTraceDetailRoute,
			promptsRoute,
			newPromptRoute,
			promptDetailRoute,
			promptEditRoute,
			datasetsRoute,
			datasetDetailRoute,
			evaluationsRoute,
			evaluationDetailRoute,
			evaluationRunDetailRoute,
			feedbackRoute,
			projectsRoute,
			governanceRoute,
			adminAccessRoute,
			passwordChangeRoute,
			otlpCredentialsRoute,
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
