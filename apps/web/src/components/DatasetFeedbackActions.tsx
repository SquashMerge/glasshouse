import * as React from "react";
import { LuThumbsDown, LuThumbsUp } from "react-icons/lu";
import {
	ApiError,
	captureDatasetDraftItem,
	createFeedback,
	getOwnFeedback,
	getDatasetDraft,
	listDatasets,
	type Feedback,
} from "../lib/api";
import { Button } from "./ui/button";
import { DialogContent, DialogOverlay } from "./ui/dialog";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Select } from "./ui/select";

export function AddToDatasetDialog({
	projectId,
	traceId,
	observationId,
	label,
	canCurate = true,
}: {
	projectId: string | null;
	traceId: string;
	observationId?: string;
	label: string;
	canCurate?: boolean;
}) {
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const dialogRef = React.useRef<HTMLDivElement>(null);
	const captureAttempt = React.useRef<{
		idempotency_key: string;
		revision: number | undefined;
	} | null>(null);
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
		if (!canCurate || !open || !projectId) return;
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
	}, [canCurate, datasetLoadAttempt, open, projectId]);
	React.useEffect(() => {
		setDatasetId("");
		setError("");
		captureAttempt.current = null;
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
	async function existingDraftRevision(slug: string) {
		if (!projectId) return undefined;
		try {
			return (await getDatasetDraft({ project_id: projectId, slug })).revision;
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 404) return undefined;
			throw cause;
		}
	}
	async function submit() {
		if (!canCurate || !projectId || !datasetId || pending) return;
		try {
			setError("");
			setPending(true);
			const selected = datasets.find((dataset) => dataset.id === datasetId);
			if (!selected) throw new Error("Dataset is no longer available");
			const attempt = captureAttempt.current ?? {
				idempotency_key: crypto.randomUUID(),
				revision: await existingDraftRevision(selected.slug),
			};
			captureAttempt.current ??= attempt;
			await captureDatasetDraftItem({
				project_id: projectId,
				slug: selected.slug,
				revision: attempt.revision,
				idempotency_key: attempt.idempotency_key,
				source_trace_id: traceId,
				source_observation_id: observationId,
			});
			captureAttempt.current = null;
			close();
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setPending(false);
		}
	}
	if (!canCurate) return null;
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
				<DialogOverlay
					ref={dialogRef}
					onEscape={() => !pending && close()}
					onKeyDown={(event) => {
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
					<DialogContent
						className="max-w-xl space-y-3 p-5"
						role="dialog"
						aria-modal="true"
						aria-labelledby="add-to-dataset-title"
					>
						<h2 id="add-to-dataset-title" className="font-semibold">
							Capture {label} as a Dataset draft
						</h2>
						<label className="block text-sm" htmlFor="dataset-choice">
							Dataset
							<Select
								id="dataset-choice"
								className="h-9"
								value={datasetId}
								onChange={(event) => {
									captureAttempt.current = null;
									setDatasetId(event.target.value);
								}}
							>
								<option value="">Choose a dataset</option>
								{datasets.map((dataset) => (
									<option key={dataset.id} value={dataset.id}>
										{dataset.name}
									</option>
								))}
							</Select>
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
							Glasshouse reads the selected source again on the server, applies
							the active redaction policy, and saves an unpublished item for
							review. Source text in this browser is never submitted as Dataset
							content.
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
					</DialogContent>
				</DialogOverlay>
			)}
		</>
	);
}
type FeedbackControlsProps = {
	projectId: string | null;
	traceId: string;
	observationId?: string;
	label: string;
	canCurate?: boolean;
};
export function FeedbackControls(props: FeedbackControlsProps) {
	return (
		<FeedbackTarget
			key={JSON.stringify([
				props.projectId,
				props.traceId,
				props.observationId,
			])}
			{...props}
		/>
	);
}
function FeedbackTarget({
	projectId,
	traceId,
	observationId,
	label,
	canCurate = true,
}: FeedbackControlsProps) {
	const [reason, setReason] = React.useState("");
	const [comment, setComment] = React.useState("");
	const commentRef = React.useRef("");
	const [negative, setNegative] = React.useState(false);
	const [message, setMessage] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [saved, setSaved] = React.useState<Feedback | null>(null);
	const [loading, setLoading] = React.useState(true);
	const [loadError, setLoadError] = React.useState("");
	const [loadAttempt, setLoadAttempt] = React.useState(0);
	const active = React.useRef(true);
	const submitting = React.useRef(false);
	React.useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	React.useEffect(() => {
		if (!projectId) return;
		let current = true;
		setLoading(true);
		setLoadError("");
		getOwnFeedback({
			project_id: projectId,
			trace_id: traceId,
			observation_id: observationId,
		})
			.then((value) => {
				if (current) setSaved(value);
			})
			.catch(() => {
				if (current) setLoadError("Could not load your feedback.");
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [projectId, traceId, observationId, canCurate, loadAttempt]);
	const idempotencyKeys = React.useRef<
		Partial<Record<"positive" | "negative", string>>
	>({});
	React.useEffect(() => {
		idempotencyKeys.current = {};
	}, [observationId, traceId]);
	async function record(value: 1 | -1) {
		const trimmedComment = commentRef.current.trim();
		if (
			!canCurate ||
			pending ||
			submitting.current ||
			loading ||
			!!loadError ||
			!!saved ||
			!projectId ||
			(value === -1 && !reason.trim())
		) {
			setNegative(true);
			return;
		}
		const intent = value === 1 ? "positive" : "negative";
		const idempotency_key =
			idempotencyKeys.current[intent] ?? crypto.randomUUID();
		idempotencyKeys.current[intent] = idempotency_key;
		try {
			submitting.current = true;
			setPending(true);
			const result = await createFeedback({
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
						...(trimmedComment ? { comment: trimmedComment } : {}),
					},
				},
			});
			if (!active.current) return;
			setSaved(result);
			setMessage("");
			setNegative(false);
			delete idempotencyKeys.current[intent];
		} catch (cause) {
			if (active.current) setMessage((cause as Error).message);
		} finally {
			submitting.current = false;
			if (active.current) setPending(false);
		}
	}
	if (!canCurate && !saved) {
		if (loadError) {
			return (
				<span role="alert">
					{loadError}{" "}
					<Button size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
						Retry
					</Button>
				</span>
			);
		}
		return projectId && loading ? (
			<span role="status">Loading your feedback...</span>
		) : null;
	}
	return (
		<div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
			<Button
				type="button"
				size="icon"
				variant="outline"
				onClick={() => void record(1)}
				aria-label={`Thumbs up ${label}`}
				aria-pressed={saved?.value === 1}
				className={
					saved?.value === 1 ? "border-primary ring-2 ring-primary" : undefined
				}
				title={`Thumbs up ${label}`}
				disabled={pending || loading || !!loadError || !!saved || !projectId}
			>
				<LuThumbsUp className="h-4 w-4" aria-hidden="true" />
			</Button>
			<Button
				type="button"
				size="icon"
				variant="outline"
				onClick={() => setNegative(true)}
				aria-label={`Thumbs down ${label}`}
				aria-pressed={saved?.value === -1}
				className={
					saved?.value === -1 ? "border-primary ring-2 ring-primary" : undefined
				}
				title={`Thumbs down ${label}`}
				disabled={pending || loading || !!loadError || !!saved || !projectId}
			>
				<LuThumbsDown className="h-4 w-4" aria-hidden="true" />
			</Button>
			{!saved && (
				<Input
					className="h-8 w-full max-w-48"
					placeholder="Optional comment"
					aria-label="Comment"
					value={comment}
					disabled={!projectId || loading || !!loadError || pending}
					onChange={(event) => {
						commentRef.current = event.target.value;
						setComment(event.target.value);
					}}
				/>
			)}
			{loading && <span role="status">Loading your feedback...</span>}
			{loadError && (
				<span role="alert">
					{loadError}{" "}
					<Button size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
						Retry
					</Button>
				</span>
			)}
			{saved && (
				<span role="status">
					Your feedback: {saved.sentiment}
					{saved.reason ? ` · ${saved.reason}` : ""}
					{saved.comment ? ` · ${saved.comment}` : ""}
				</span>
			)}
			{negative && !saved && (
				<>
					<Input
						className="h-8 w-40"
						aria-label="Reason"
						placeholder="Reason required"
						value={reason}
						disabled={!projectId}
						onChange={(event) => setReason(event.target.value)}
					/>
					<Button
						size="sm"
						disabled={pending || !projectId}
						onClick={() => void record(-1)}
					>
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
