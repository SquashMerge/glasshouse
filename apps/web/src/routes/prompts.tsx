import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { LuLoaderCircle, LuPlus } from "react-icons/lu";
import { Button, buttonVariants } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	getActivePromptOptimization,
	listPrompts,
} from "../lib/api";

export function PromptsPage() {
	const {
		selectedProject,
		selectedProjectId,
		isLoading: projectsLoading,
		error: projectsError,
	} = useProjectSelection();
	const promptsQuery = useQuery({
		queryKey: ["prompts", selectedProjectId],
		queryFn: () => listPrompts(selectedProjectId!),
		enabled: Boolean(selectedProjectId),
	});
	const activeOptimizationQueries = useQueries({
		queries: (promptsQuery.data?.items ?? []).map((prompt) => ({
			queryKey: ["prompt-optimization", selectedProjectId, prompt.id],
			queryFn: () =>
				getActivePromptOptimization({
					project_id: selectedProjectId!,
					slug: prompt.id,
				}),
			enabled: Boolean(selectedProjectId),
		})),
	});

	if (projectsLoading) {
		return <PageMessage title="Prompts">Loading projects…</PageMessage>;
	}

	if (!selectedProject) {
		return (
			<PageMessage title="Prompts">
				{projectsError
					? "Projects could not be loaded. Retry from the project selector."
					: "Select a project to manage its prompts."}
			</PageMessage>
		);
	}

	return (
		<div className="space-y-6" data-testid="prompts-page">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Prompts</h1>
					<p className="text-sm text-muted-foreground">
						{selectedProject.name}
					</p>
				</div>
				<Link
					to="/prompts/new"
					aria-label="New prompt"
					className={buttonVariants()}
				>
					<LuPlus className="h-4 w-4" aria-hidden="true" />
					New prompt
				</Link>
			</div>

			{promptsQuery.isLoading && (
				<PageMessage title="Prompts">Loading prompts…</PageMessage>
			)}
			{promptsQuery.isError && (
				<Alert variant="destructive" aria-live="assertive">
					<AlertTitle>Prompts could not be loaded</AlertTitle>
					<AlertDescription className="flex items-center justify-between gap-3">
						<span>{(promptsQuery.error as Error).message}</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => void promptsQuery.refetch()}
						>
							Retry
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{promptsQuery.data && promptsQuery.data.items.length === 0 && (
				<Card data-testid="prompts-empty">
					<CardHeader>
						<CardTitle>No prompts yet</CardTitle>
					</CardHeader>
					<CardContent className="text-sm text-muted-foreground">
						Create a prompt for this project to start versioning it.
					</CardContent>
				</Card>
			)}
			{promptsQuery.data && promptsQuery.data.items.length > 0 && (
				<Card>
					<CardContent className="p-0">
						<div className="hidden grid-cols-[minmax(0,1fr)_130px_180px] gap-4 border-b px-4 py-3 text-xs font-medium text-muted-foreground md:grid">
							<span>Prompt</span>
							<span>Latest version</span>
							<span>Updated</span>
						</div>
						<ul className="divide-y divide-border" aria-label="Project prompts">
							{promptsQuery.data.items.map((prompt, index) => {
								const activeOptimization =
									activeOptimizationQueries[index]?.data;
								const optimizationActive =
									activeOptimization !== null &&
									activeOptimization !== undefined &&
									!["completed", "stopped", "failed"].includes(
										activeOptimization.status,
									);
								return (
									<li key={prompt.id}>
									<Link
										to="/prompts/$slug"
										params={{ slug: prompt.id }}
										className="grid gap-2 px-4 py-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_130px_180px] md:items-center md:gap-4"
										data-testid="prompt-row"
									>
										<span className="min-w-0">
											<span className="block truncate font-medium">
												{prompt.name}
											</span>
											<span className="block truncate font-mono text-xs text-muted-foreground">
												{prompt.id}
											</span>
											{optimizationActive && (
												<span className="mt-1 flex items-center gap-1 text-xs text-primary">
													<LuLoaderCircle
														className="h-3 w-3 animate-spin"
														data-testid="optimization-spinner"
														aria-hidden="true"
													/>
													Optimizing…
												</span>
											)}
										</span>
										<span className="text-sm">v{prompt.version}</span>
										<time
											dateTime={prompt.created_at}
											className="text-sm text-muted-foreground"
										>
											{formatDate(prompt.created_at)}
										</time>
									</Link>
								</li>
								);
							})}
						</ul>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

export function PageMessage({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="text-sm text-muted-foreground">
				{children}
			</CardContent>
		</Card>
	);
}

export function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
