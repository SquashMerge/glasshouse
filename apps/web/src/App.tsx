import {
	createRouter,
	RouterProvider,
	createRootRoute,
	createRoute,
	Outlet,
} from "@tanstack/react-router";
import { DashboardPage } from "./routes/index";
import { LoginPage } from "./routes/login";
import { SetupPage } from "./routes/setup";
import { EnrollmentPage } from "./routes/enroll";
import { ObservabilityPage } from "./routes/observability";
import { TraceDetailPage } from "./routes/observability/traces/$id";
import { PromptsPage } from "./routes/prompts";
import { NewPromptPage } from "./routes/prompts-new";
import { PromptDetailPage } from "./routes/prompts-detail";
import { EditPromptPage } from "./routes/prompts-edit";
import { DatasetsPage, DatasetDetailPage } from "./routes/datasets";
import {
	EvaluationDefinitionDetailPage,
	EvaluationDetailPage,
	EvaluationsPage,
} from "./routes/evaluations";
import { FeedbackPage } from "./routes/feedback";
import { ProjectsPage } from "./routes/projects";
import { GovernancePage } from "./routes/governance";
import { AdminAccessPage } from "./routes/admin-access";
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
const setupRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/setup",
	component: SetupPage,
});
const enrollmentRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/enroll",
	component: EnrollmentPage,
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
const datasetsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/datasets",
	component: DatasetsPage,
});
const datasetDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/datasets/$id",
	component: DatasetDetailPage,
});
const evaluationsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/evaluations",
	component: EvaluationsPage,
});
const evaluationDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/evaluation-definitions/$slug",
	component: EvaluationDefinitionDetailPage,
});
const evaluationRunDetailRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/evaluations/$id",
	component: EvaluationDetailPage,
});
const feedbackRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/feedback",
	component: FeedbackPage,
});
const projectsRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/projects",
	component: ProjectsPage,
});
const governanceRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/governance",
	component: GovernancePage,
});
const adminAccessRoute = createRoute({
	getParentRoute: () => protectedRoute,
	path: "/access",
	component: AdminAccessPage,
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
