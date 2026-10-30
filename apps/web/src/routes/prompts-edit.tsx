import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	getActivePromptOptimization,
	getPrompt,
	stopPromptOptimization,
	type Prompt,
} from "../lib/api";
import { PageMessage } from "./prompts";
import { FormLoadingSkeleton } from "../components/LoadingSkeletons";
import { PromptComposer } from "./prompts-new";
import { Button } from "../components/ui/button";

export function EditPromptPage() {
	const { slug } = useParams({ from: "/protected/prompts/$slug/edit" });
	const location = useLocation();
	const navigate = useNavigate();
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const fromVersion = queryVersion(location.searchStr, "from");
	const [confirmStop, setConfirmStop] = useState(false);
	const contextKey = JSON.stringify([selectedProjectId, slug, fromVersion]);
	const [loadedSource, setLoadedSource] = useState<{
		contextKey: string;
		current: Prompt;
		selected: Prompt;
	} | null>(null);

	const currentQuery = useQuery({
		queryKey: ["prompt", selectedProjectId, slug, "current"],
		queryFn: () => getPrompt({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
	});
	const selectedQuery = useQuery({
		queryKey: ["prompt", selectedProjectId, slug, fromVersion],
		queryFn: () =>
			getPrompt({
				project_id: selectedProjectId!,
				slug,
				version: fromVersion!,
			}),
		enabled: Boolean(selectedProjectId && fromVersion),
	});
	const activeOptimizationQuery = useQuery({
		queryKey: ["prompt-optimization", selectedProjectId, slug],
		queryFn: () =>
			getActivePromptOptimization({ project_id: selectedProjectId!, slug }),
		enabled: Boolean(selectedProjectId),
		refetchInterval: (query) => (query.state.data ? 5_000 : false),
		refetchIntervalInBackground: true,
	});
	const stopMutation = useMutation({
		mutationFn: () =>
			stopPromptOptimization({
				project_id: selectedProjectId!,
				id: activeOptimizationQuery.data!.id,
			}),
		onSuccess: () => void activeOptimizationQuery.refetch(),
	});

	const selectedData = fromVersion ? selectedQuery.data : currentQuery.data;
	useEffect(() => {
		// Keep this editor's source snapshot while session focus resets queries.
		setLoadedSource((previous) => {
			if (currentQuery.data && selectedData) {
				return {
					contextKey,
					current: currentQuery.data,
					selected: selectedData,
				};
			}
			return previous?.contextKey === contextKey ? previous : null;
		});
	}, [contextKey, currentQuery.data, selectedData]);
	const retainedSource =
		loadedSource?.contextKey === contextKey ? loadedSource : null;
	const current = currentQuery.data ?? retainedSource?.current;
	const selected = selectedData ?? retainedSource?.selected;

	if (!selectedProjectId || !selectedProject) {
		return (
			<PageMessage title="New prompt version">
				Select a project before creating a prompt version.
			</PageMessage>
		);
	}

	if (
		(currentQuery.isLoading && !current) ||
		(fromVersion && selectedQuery.isLoading && !selected)
	) {
		return <FormLoadingSkeleton testId="prompt-edit-skeleton" />;
	}
	if (activeOptimizationQuery.data) {
		return (
			<PageMessage title="New prompt version">
				An optimization is active. Stop it before editing this prompt.
				{confirmStop ? (
					<span className="mt-4 block">
						Stopping is final and prevents publication.{" "}
						<Button
							variant="destructive"
							className="ml-2"
							onClick={() => stopMutation.mutate()}
							disabled={stopMutation.isPending}
						>
							{stopMutation.isPending ? "Stopping…" : "Confirm stop"}
						</Button>
						<Button
							variant="outline"
							className="ml-2"
							onClick={() => setConfirmStop(false)}
							disabled={stopMutation.isPending}
						>
							Cancel
						</Button>
					</span>
				) : (
					<Button className="mt-4" onClick={() => setConfirmStop(true)}>
						Stop optimization
					</Button>
				)}
			</PageMessage>
		);
	}

	const error = currentQuery.error ?? selectedQuery.error;
	if (error || !current || !selected) {
		return (
			<PageMessage title="New prompt version">
				{error instanceof Error ? error.message : "Prompt could not be loaded."}
			</PageMessage>
		);
	}

	return (
		<PromptComposer
			key={`${contextKey}:${selected.version}`}
			projectId={selectedProjectId}
			existing={selected}
			current={current}
			onSaved={(prompt) => {
				navigate({
					to: "/prompts/$slug",
					params: { slug: prompt.id },
					search: { version: prompt.version },
				});
			}}
		/>
	);
}

function queryVersion(search: string, key: string): number | undefined {
	const value = new URLSearchParams(search).get(key);
	if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
	const version = Number(value);
	return Number.isSafeInteger(version) ? version : undefined;
}
