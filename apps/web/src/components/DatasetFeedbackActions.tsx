import * as React from "react";
import {
	addDatasetItem,
	createFeedback,
	listDatasets,
	type JsonObject,
} from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function jsonObject(value: string, label: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${label} must be valid JSON object`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${label} must be a JSON object`);
	return parsed as JsonObject;
}
function initialJson(value: string | undefined) {
	if (!value) return "{}";
	try {
		return JSON.stringify(jsonObject(value, "Value"), null, 2);
	} catch {
		return value;
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
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const [datasetId, setDatasetId] = React.useState("");
	const [input, setInput] = React.useState(() => initialJson(inputText));
	const [expected, setExpected] = React.useState(() => initialJson(outputText));
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [datasets, setDatasets] = React.useState<
		Array<{ id: string; name: string }>
	>([]);
	React.useEffect(() => {
		if (!open || !projectId) return;
		void listDatasets(projectId).then((result) => setDatasets(result.items));
	}, [open, projectId]);
	React.useEffect(() => {
		setDatasetId("");
		setInput(initialJson(inputText));
		setExpected(initialJson(outputText));
		setError("");
	}, [projectId, traceId, observationId]);
	function close() {
		setOpen(false);
		setTimeout(() => triggerRef.current?.focus(), 0);
	}
	async function submit() {
		if (!projectId || !datasetId || pending) return;
		try {
			setError("");
			const parsedInput = jsonObject(input, "Input");
			const parsedExpected = jsonObject(expected, "Expected output");
			setPending(true);
			await addDatasetItem({
				project_id: projectId,
				dataset_id: datasetId,
				input: parsedInput,
				expected_output: parsedExpected,
				source_trace_id: traceId,
				source_observation_id: observationId,
			});
			close();
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setPending(false);
		}
	}
	return (
		<>
			<Button
				ref={triggerRef}
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
					aria-modal="true"
					aria-labelledby="add-to-dataset-title"
					onKeyDown={(event) => {
						if (event.key === "Escape") close();
					}}
				>
					<div className="w-full max-w-xl space-y-3 rounded-lg bg-background p-5 shadow-lg">
						<h2 id="add-to-dataset-title" className="font-semibold">
							Add {label} to dataset
						</h2>
						<label className="block text-sm" htmlFor="dataset-choice">
							Dataset
							<select
								id="dataset-choice"
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
						</label>
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
						{error && (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={close} disabled={pending}>
								Cancel
							</Button>
							<Button
								disabled={pending || !datasetId}
								onClick={() => void submit()}
							>
								{pending ? "Adding..." : "Add case"}
							</Button>
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
	const [pending, setPending] = React.useState(false);
	const idempotencyKeys = React.useRef<
		Partial<Record<"positive" | "negative", string>>
	>({});
	async function record(value: 1 | -1) {
		if (pending || !projectId || (value === -1 && !reason.trim())) {
			setNegative(true);
			return;
		}
		const intent = value === 1 ? "positive" : "negative";
		const idempotency_key =
			idempotencyKeys.current[intent] ?? crypto.randomUUID();
		idempotencyKeys.current[intent] = idempotency_key;
		try {
			setPending(true);
			await createFeedback({
				project_id: projectId,
				trace_id: traceId,
				observation_id: observationId,
				value,
				idempotency_key,
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
			delete idempotencyKeys.current[intent];
		} catch (cause) {
			setMessage((cause as Error).message);
		} finally {
			setPending(false);
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
				disabled={pending}
			>
				Thumbs up
			</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => setNegative(true)}
				aria-label={`Thumbs down ${label}`}
				disabled={pending}
			>
				Thumbs down
			</Button>
			{negative && (
				<>
					<Input
						className="h-8 w-40"
						aria-label="Reason"
						placeholder="Reason required"
						value={reason}
						onChange={(event) => setReason(event.target.value)}
					/>
					<Input
						className="h-8 w-48"
						placeholder="Optional comment"
						aria-label="Comment"
						value={comment}
						onChange={(event) => setComment(event.target.value)}
					/>
					<Button size="sm" disabled={pending} onClick={() => void record(-1)}>
						{pending ? "Recording..." : "Record"}
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
