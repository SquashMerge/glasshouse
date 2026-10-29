import { useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import { DialogContent, DialogOverlay } from "../components/ui/dialog";

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
	const contentRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (pending) contentRef.current?.focus();
	}, [pending]);

	return (
		<DialogOverlay
			onEscape={() => !pending && onClose()}
			onMouseDown={() => !pending && onClose()}
		>
			<DialogContent
				ref={contentRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="rollback-latest-version-title"
				className="max-w-md"
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
			</DialogContent>
		</DialogOverlay>
	);
}
