import { useState } from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useProjectSelection } from "../components/ProjectProvider";
import {
	getActivePromptOptimization,
	getPrompt,
	stopPromptOptimization,
} from "../lib/api";
import { PageMessage } from "./prompts";
import { FormLoadingSkeleton } from "../components/LoadingSkeletons";
import { PromptComposer } from "./prompts-new";

export function EditPromptPage() {
	const { slug } = useParams({ from: "/protected/prompts/$slug/edit" });
	const location = useLocation();
	const navigate = useNavigate();
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const fromVersion = queryVersion(location.searchStr, "from");
	const [confirmStop, setConfirmStop] = useState(false);

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

	if (!selectedProjectId || !selectedProject) {
		return (
			<PageMessage title="New prompt version">
				Select a project before creating a prompt version.
			</PageMessage>
		);
	}

	if (
		(currentQuery.isLoading && !currentQuery.data) ||
		(fromVersion && selectedQuery.isLoading && !selectedQuery.data)
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
						<button
							type="button"
							className="ml-2 rounded-md border border-destructive px-3 py-2 text-sm"
							onClick={() => stopMutation.mutate()}
							disabled={stopMutation.isPending}
						>
							{stopMutation.isPending ? "Stopping…" : "Confirm stop"}
						</button>
						<button
							type="button"
							className="ml-2 rounded-md border px-3 py-2 text-sm"
							onClick={() => setConfirmStop(false)}
							disabled={stopMutation.isPending}
						>
							Cancel
						</button>
					</span>
				) : (
					<button
						type="button"
						className="mt-4 block rounded-md border px-3 py-2 text-sm"
						onClick={() => setConfirmStop(true)}
					>
						Stop optimization
					</button>
				)}
			</PageMessage>
		);
	}

	const error = currentQuery.error ?? selectedQuery.error;
	if (error || !currentQuery.data || (fromVersion && !selectedQuery.data)) {
		return (
			<PageMessage title="New prompt version">
				{error instanceof Error ? error.message : "Prompt could not be loaded."}
			</PageMessage>
		);
	}

	const selected = fromVersion ? selectedQuery.data! : currentQuery.data;
	return (
		<PromptComposer
			projectId={selectedProjectId}
			existing={selected}
			current={currentQuery.data}
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
