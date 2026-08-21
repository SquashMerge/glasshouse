import * as React from "react";
import {
	captureDatasetDraftItem,
	createDatasetDraft,
	createFeedback,
	listDatasets,
} from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

export function AddToDatasetDialog({
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
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const dialogRef = React.useRef<HTMLDivElement>(null);
	const idempotencyKey = React.useRef<string | null>(null);
	const [datasetId, setDatasetId] = React.useState("");
	const [error, setError] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [datasetLoading, setDatasetLoading] = React.useState(false);
	const [datasetLoadError, setDatasetLoadError] = React.useState("");
	const [datasetLoadAttempt, setDatasetLoadAttempt] = React.useState(0);
	const [datasets, setDatasets] = React.useState<
		Array<{ id: string; name: string; slug: string }>
	>([]);
	React.useEffect(() => {
		if (!open || !projectId) return;
		const currentProjectId = projectId;
		let active = true;
		async function loadDatasets() {
			setDatasetLoading(true);
			setDatasetLoadError("");
			try {
				const result = await listDatasets(currentProjectId);
				if (active) setDatasets(result.items);
			} catch (cause) {
				if (active) setDatasetLoadError((cause as Error).message);
			} finally {
				if (active) setDatasetLoading(false);
			}
		}
		void loadDatasets();
		return () => {
			active = false;
		};
	}, [datasetLoadAttempt, open, projectId]);
	React.useEffect(() => {
		setDatasetId("");
		setError("");
		idempotencyKey.current = null;
	}, [projectId, traceId, observationId]);
	React.useEffect(() => {
		if (!open) return;
		dialogRef.current
			?.querySelector<HTMLElement>(
				"select:not(:disabled), textarea:not(:disabled), button:not(:disabled)",
			)
			?.focus();
	}, [open]);
	function close() {
		setOpen(false);
		setTimeout(() => triggerRef.current?.focus(), 0);
	}
	async function submit() {
		if (!projectId || !datasetId || pending) return;
		try {
			setError("");
			setPending(true);
			const selected = datasets.find((dataset) => dataset.id === datasetId);
			if (!selected) throw new Error("Dataset is no longer available");
			const draft = await createDatasetDraft({
				project_id: projectId,
				slug: selected.slug,
			});
			idempotencyKey.current ??= crypto.randomUUID();
			await captureDatasetDraftItem({
				project_id: projectId,
				slug: selected.slug,
				revision: draft.revision,
				idempotency_key: idempotencyKey.current,
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
					ref={dialogRef}
					className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
					role="dialog"
					aria-modal="true"
					aria-labelledby="add-to-dataset-title"
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							close();
							return;
						}
						if (event.key !== "Tab") return;
						const focusable = Array.from(
							dialogRef.current?.querySelectorAll<HTMLElement>(
								'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
							) ?? [],
						);
						const first = focusable[0];
						const last = focusable.at(-1);
						if (!first || !last) return;
						if (event.shiftKey && document.activeElement === first) {
							event.preventDefault();
							last.focus();
							return;
						}
						if (!event.shiftKey && document.activeElement === last) {
							event.preventDefault();
							first.focus();
						}
					}}
				>
					<div className="w-full max-w-xl space-y-3 rounded-lg bg-background p-5 shadow-lg">
						<h2 id="add-to-dataset-title" className="font-semibold">
							Capture {label} as a Dataset draft
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
						{datasetLoading && (
							<Skeleton
								className="h-4 w-32"
								data-testid="dataset-options-skeleton"
								role="status"
								aria-label="Loading choices"
							/>
						)}
						{datasetLoadError && (
							<div className="flex items-center gap-2" role="alert">
								<span>{datasetLoadError}</span>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() =>
										setDatasetLoadAttempt((attempt) => attempt + 1)
									}
								>
									Retry datasets
								</Button>
							</div>
						)}
						<p
							className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
							role="status"
						>
							Astraea reads the selected source again on the server, applies the
							active redaction policy, and saves an unpublished item for review.
							Source text in this browser is never submitted as Dataset content.
						</p>
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
								{pending ? "Capturing..." : "Capture redacted case"}
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
	React.useEffect(() => {
		idempotencyKeys.current = {};
	}, [observationId, traceId]);
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
			<Input
				className="h-8 w-48"
				placeholder="Optional comment"
				aria-label="Comment"
				value={comment}
				onChange={(event) => setComment(event.target.value)}
			/>
			{negative && (
				<>
					<Input
						className="h-8 w-40"
						aria-label="Reason"
						placeholder="Reason required"
						value={reason}
						onChange={(event) => setReason(event.target.value)}
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
