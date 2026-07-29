import * as React from "react";
import {
	addDatasetItem,
	createFeedback,
	listDatasets,
	type JsonObject,
} from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function jsonObject(value: string): JsonObject {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: { value };
	} catch {
		return { value };
	}
}
export function AddToDatasetDialog({
	projectId,
	traceId,
	observationId,
	inputText,
	outputText,
	label,
}: {
	projectId: string | null;
	traceId: string;
	observationId?: string;
	inputText?: string;
	outputText?: string;
	label: string;
}) {
	const [open, setOpen] = React.useState(false);
	const [datasetId, setDatasetId] = React.useState("");
	const [input, setInput] = React.useState(() =>
		JSON.stringify(jsonObject(inputText ?? ""), null, 2),
	);
	const [expected, setExpected] = React.useState(() =>
		JSON.stringify(jsonObject(outputText ?? ""), null, 2),
	);
	const [error, setError] = React.useState("");
	const [datasets, setDatasets] = React.useState<
		Array<{ id: string; name: string }>
	>([]);
	React.useEffect(() => {
		if (!open || !projectId) return;
		void listDatasets(projectId).then((result) => setDatasets(result.items));
	}, [open, projectId]);
	async function submit() {
		if (!projectId || !datasetId) return;
		try {
			await addDatasetItem({
				project_id: projectId,
				dataset_id: datasetId,
				input: jsonObject(input),
				expected_output: jsonObject(expected),
				source_trace_id: traceId,
				source_observation_id: observationId,
			});
			setOpen(false);
		} catch (cause) {
			setError((cause as Error).message);
		}
	}
	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => setOpen(true)}
			>
				Add to dataset
			</Button>
			{open && (
				<div
					className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
					role="dialog"
					aria-label={`Add ${label} to dataset`}
				>
					<div className="w-full max-w-xl space-y-3 rounded-lg bg-background p-5 shadow-lg">
						<h2 className="font-semibold">Add {label} to dataset</h2>
						<select
							className="h-9 w-full rounded border px-2"
							value={datasetId}
							onChange={(event) => setDatasetId(event.target.value)}
						>
							<option value="">Choose a dataset</option>
							{datasets.map((dataset) => (
								<option key={dataset.id} value={dataset.id}>
									{dataset.name}
								</option>
							))}
						</select>
						<label className="block text-sm">
							Input
							<textarea
								className="mt-1 min-h-24 w-full rounded border p-2 font-mono text-xs"
								value={input}
								onChange={(event) => setInput(event.target.value)}
							/>
						</label>
						<label className="block text-sm">
							Expected output suggestion
							<textarea
								className="mt-1 min-h-24 w-full rounded border p-2 font-mono text-xs"
								value={expected}
								onChange={(event) => setExpected(event.target.value)}
							/>
						</label>
						{error && <p className="text-sm text-destructive">{error}</p>}
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button onClick={() => void submit()}>Add case</Button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
export function FeedbackControls({
	projectId,
	traceId,
	observationId,
	label,
}: {
	projectId: string | null;
	traceId: string;
	observationId?: string;
	label: string;
}) {
	const [reason, setReason] = React.useState("");
	const [comment, setComment] = React.useState("");
	const [negative, setNegative] = React.useState(false);
	const [message, setMessage] = React.useState("");
	async function record(value: 1 | -1) {
		if (!projectId || (value === -1 && !reason.trim())) {
			setNegative(true);
			return;
		}
		try {
			await createFeedback({
				project_id: projectId,
				trace_id: traceId,
				observation_id: observationId,
				value,
				metadata: {
					feedback: {
						schema_version: 1,
						sentiment: value === 1 ? "positive" : "negative",
						...(value === -1 ? { reason } : {}),
						...(comment.trim() ? { comment } : {}),
					},
				},
			});
			setMessage(value === -1 ? "Added to review queue" : "Recorded");
			setNegative(false);
		} catch (cause) {
			setMessage((cause as Error).message);
		}
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => void record(1)}
				aria-label={`Thumbs up ${label}`}
			>
				Thumbs up
			</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => setNegative(true)}
				aria-label={`Thumbs down ${label}`}
			>
				Thumbs down
			</Button>
			{negative && (
				<>
					<Input
						className="h-8 w-40"
						placeholder="Reason required"
						value={reason}
						onChange={(event) => setReason(event.target.value)}
					/>
					<Input
						className="h-8 w-48"
						placeholder="Optional comment"
						value={comment}
						onChange={(event) => setComment(event.target.value)}
					/>
					<Button size="sm" onClick={() => void record(-1)}>
						Record
					</Button>
				</>
			)}
			{message && (
				<span className="text-xs text-muted-foreground" role="status">
					{message}
				</span>
			)}
		</div>
	);
}
