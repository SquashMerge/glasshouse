import { Button } from "../components/ui/button";

export function RollbackLatestVersionDialog({
	pending,
	error,
	onClose,
	onConfirm,
}: {
	pending: boolean;
	error: string | null;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4"
			onMouseDown={onClose}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="rollback-latest-version-title"
				className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<h2
					id="rollback-latest-version-title"
					className="text-lg font-semibold"
				>
					Rollback latest version
				</h2>
				<p className="mt-3 text-sm text-muted-foreground">
					The latest version will be permanently removed and the previous
					version restored.
				</p>
				{error && (
					<p
						className="mt-3 text-sm text-destructive"
						role="alert"
						aria-live="assertive"
					>
						{error}
					</p>
				)}
				<div className="mt-6 flex justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						disabled={pending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={onConfirm}
						disabled={pending}
					>
						{pending ? "Rolling back..." : "Rollback version"}
					</Button>
				</div>
			</div>
		</div>
	);
}
