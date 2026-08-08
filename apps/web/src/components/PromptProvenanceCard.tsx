import { useQuery } from "@tanstack/react-query";
import { useProjectSelection } from "./ProjectProvider";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { getPromptProvenance, type PromptProvenance } from "../lib/api";

export function PromptProvenanceCard({
	provenance,
}: {
	provenance: PromptProvenance | null;
}) {
	const { selectedProjectId } = useProjectSelection();
	const statusQuery = useQuery({
		queryKey: [
			"prompt-provenance",
			selectedProjectId,
			provenance?.id,
			provenance?.version,
			provenance?.content_hash,
		],
		queryFn: () =>
			getPromptProvenance({
				project_id: selectedProjectId!,
				id: provenance!.id,
				version: provenance!.version,
				content_hash: provenance!.content_hash,
			}),
		enabled: Boolean(selectedProjectId && provenance),
	});

	return (
		<Card data-testid="prompt-provenance-card">
			<CardHeader>
				<CardTitle>Prompt provenance</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				{!provenance && (
					<p className="text-muted-foreground">
						No prompt provenance was recorded for this generation.
					</p>
				)}
				{provenance && (
					<dl className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
						<dt className="text-muted-foreground">Prompt</dt>
						<dd className="font-mono">{provenance.id}</dd>
						<dt className="text-muted-foreground">Version</dt>
						<dd>v{provenance.version}</dd>
						<dt className="text-muted-foreground">Content hash</dt>
						<dd className="break-all font-mono text-xs">
							{provenance.content_hash}
						</dd>
					</dl>
				)}
				{provenance && !selectedProjectId && (
					<p
						className="text-muted-foreground"
						data-testid="provenance-no-project"
					>
						Select a project to check this prompt's status.
					</p>
				)}
				{provenance && selectedProjectId && statusQuery.isLoading && (
					<div className="flex items-center gap-2" aria-live="polite">
						<span className="text-muted-foreground">Status</span>
						<Skeleton
							className="h-5 w-16"
							data-testid="provenance-status-skeleton"
							role="status"
							aria-label="Loading prompt status"
						/>
					</div>
				)}
				{provenance && selectedProjectId && statusQuery.isError && (
					<p className="text-destructive" role="alert" aria-live="assertive">
						{(statusQuery.error as Error).message}
					</p>
				)}
				{provenance && selectedProjectId && statusQuery.data && (
					<div className="flex items-center gap-2" aria-live="polite">
						<span className="text-muted-foreground">Status</span>
						<Badge
							variant={
								statusQuery.data.status === "active"
									? "success"
									: statusQuery.data.status === "deleted"
										? "destructive"
										: "secondary"
							}
							data-testid="provenance-status"
						>
							{statusQuery.data.status}
						</Badge>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
