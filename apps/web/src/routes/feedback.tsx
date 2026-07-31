import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	listDatasets,
	listFeedback,
	promoteFeedback,
	reviewFeedback,
	type Feedback,
} from "../lib/api";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { PageMessage } from "./prompts";
export function FeedbackPage() {
	const { selectedProjectId, selectedProject } = useProjectSelection();
	const client = useQueryClient();
	const [queue, setQueue] = React.useState(true);
	const [sentiment, setSentiment] = React.useState("");
	const [status, setStatus] = React.useState("");
	const [target, setTarget] = React.useState("");
	const feedback = useQuery({
		queryKey: ["feedback", selectedProjectId, queue, sentiment, status, target],
		queryFn: () =>
			listFeedback({
				project_id: selectedProjectId!,
				...(queue ? { sentiment: "negative", status: "new" } : {}),
				...(sentiment ? { sentiment } : {}),
				...(status ? { status } : {}),
				...(target ? { target_type: target } : {}),
			}),
		enabled: Boolean(selectedProjectId),
	});
	if (!selectedProject)
		return (
			<PageMessage title="Feedback">
				Select a project to review feedback.
			</PageMessage>
		);
	if (feedback.isLoading)
		return <PageMessage title="Feedback">Loading feedback...</PageMessage>;
	if (feedback.isError)
		return (
			<PageMessage title="Feedback">
				Unable to load feedback.{" "}
				<Button
					size="sm"
					variant="outline"
					onClick={() => void feedback.refetch()}
				>
					Retry
				</Button>
			</PageMessage>
		);
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Feedback</h1>
				<p className="text-sm text-muted-foreground">
					Human signals require explicit review before adding a dataset case.
				</p>
			</div>
			<div className="flex gap-2">
				<Button
					variant={queue ? "default" : "outline"}
					onClick={() => setQueue(true)}
				>
					Needs review
				</Button>
				<Button
					variant={!queue ? "default" : "outline"}
					onClick={() => setQueue(false)}
				>
					All feedback
				</Button>
			</div>
			{!queue && (
				<div className="flex flex-wrap gap-2">
					<label className="sr-only" htmlFor="feedback-sentiment">
						Sentiment
					</label>
					<Select
						id="feedback-sentiment"
						className="w-auto"
						value={sentiment}
						onChange={(event) => setSentiment(event.target.value)}
					>
						<option value="">All sentiment</option>
						<option value="positive">Positive</option>
						<option value="negative">Negative</option>
					</Select>
					<label className="sr-only" htmlFor="feedback-status">
						Status
					</label>
					<Select
						id="feedback-status"
						className="w-auto"
						value={status}
						onChange={(event) => setStatus(event.target.value)}
					>
						<option value="">All status</option>
						<option value="new">New</option>
						<option value="reviewed">Reviewed</option>
						<option value="dismissed">Dismissed</option>
						<option value="added_to_dataset">Added to dataset</option>
					</Select>
					<label className="sr-only" htmlFor="feedback-target">
						Target type
					</label>
					<Select
						id="feedback-target"
						className="w-auto"
						value={target}
						onChange={(event) => setTarget(event.target.value)}
					>
						<option value="">All targets</option>
						<option value="trace">Trace</option>
						<option value="observation">Observation</option>
					</Select>
				</div>
			)}
			{feedback.data?.items.length === 0 && (
				<PageMessage title="Feedback">
					No feedback matches these filters.
				</PageMessage>
			)}
			<ul className="space-y-3">
				{feedback.data?.items.map((item) => (
					<FeedbackRow
						key={item.id}
						item={item}
						projectId={selectedProjectId!}
						onUpdated={() =>
							void client.invalidateQueries({ queryKey: ["feedback"] })
						}
					/>
				))}
			</ul>
		</div>
	);
}
function object(value: string, label: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${label} must be valid JSON object`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${label} must be a JSON object`);
	return parsed as Record<string, unknown>;
}
function FeedbackRow({
	item,
	projectId,
	onUpdated,
}: {
	item: Feedback;
	projectId: string;
	onUpdated: () => void;
}) {
	const datasets = useQuery({
		queryKey: ["datasets", projectId],
		queryFn: () => listDatasets(projectId),
	});
	const [datasetId, setDatasetId] = React.useState("");
	const [input, setInput] = React.useState("{}");
	const [expected, setExpected] = React.useState("{}");
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
	async function transition(status: string) {
		if (pending) return;
		try {
			setError("");
			setPending(true);
			await reviewFeedback({ project_id: projectId, id: item.id, status });
			onUpdated();
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setPending(false);
		}
	}
	async function promote() {
		if (pending) return;
		try {
			setError("");
			setPending(true);
			await promoteFeedback({
				project_id: projectId,
				id: item.id,
				dataset_id: datasetId,
				input: object(input, "Dataset input"),
				expected_output: object(expected, "Expected output"),
			});
			onUpdated();
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setPending(false);
		}
	}
	return (
		<li className="space-y-2 rounded border p-4">
			<div className="flex flex-wrap items-center gap-2">
				<strong>
					{item.sentiment === "negative" ? "Thumbs down" : "Thumbs up"}
				</strong>
				<span className="text-sm text-muted-foreground">
					{item.target_type} · {item.status}
				</span>
				<Link
					className="text-sm underline"
					to="/observability/traces/$id"
					params={{ id: item.trace_id }}
				>
					{item.trace_id.slice(0, 8)}...
				</Link>
			</div>
			{item.reason && <p className="text-sm">Reason: {item.reason}</p>}
			{item.comment && (
				<p className="whitespace-pre-wrap text-sm">{item.comment}</p>
			)}
			<div className="flex flex-wrap gap-2">
				{item.status !== "added_to_dataset" && (
					<>
						<Button
							size="sm"
							variant="outline"
							disabled={pending}
							onClick={() => void transition("reviewed")}
						>
							Mark reviewed
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={pending}
							onClick={() => void transition("dismissed")}
						>
							Dismiss
						</Button>
					</>
				)}
				{item.status === "reviewed" && (
					<>
						<label className="sr-only" htmlFor={`feedback-dataset-${item.id}`}>
							Dataset
						</label>
						<Select
							id={`feedback-dataset-${item.id}`}
							className="h-8 w-auto text-sm"
							value={datasetId}
							onChange={(event) => setDatasetId(event.target.value)}
						>
							<option value="">Choose dataset</option>
							{datasets.data?.items.map((dataset) => (
								<option key={dataset.id} value={dataset.id}>
									{dataset.name}
								</option>
							))}
						</Select>
						<Input
							className="h-8 w-40 text-xs"
							value={input}
							onChange={(event) => setInput(event.target.value)}
							aria-label="Dataset input JSON"
							disabled={pending}
						/>
						<Input
							className="h-8 w-40 text-xs"
							value={expected}
							onChange={(event) => setExpected(event.target.value)}
							aria-label="Expected output JSON"
							disabled={pending}
						/>
						<Button
							size="sm"
							disabled={!datasetId || pending}
							onClick={() => void promote()}
						>
							{pending ? "Updating..." : "Add to dataset"}
						</Button>
					</>
				)}
			</div>
			{error && (
				<p className="text-sm text-destructive" role="alert">
					Dataset case was not fully linked: {error}
				</p>
			)}
		</li>
	);
}
