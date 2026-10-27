import * as React from "react";
import { cn } from "../../lib/utils";

export interface DialogOverlayProps
	extends React.HTMLAttributes<HTMLDivElement> {
	onEscape?: () => void;
}

export const DialogOverlay = React.forwardRef<
	HTMLDivElement,
	DialogOverlayProps
>(({ className, onEscape, onKeyDown, ...props }, forwardedRef) => {
	const overlayRef = React.useRef<HTMLDivElement>(null);
	const restoreTimer = React.useRef<number | null>(null);
	const previousFocus = React.useRef<HTMLElement | null>(
		typeof document === "undefined"
			? null
			: (document.activeElement as HTMLElement),
	);

	React.useImperativeHandle(forwardedRef, () => overlayRef.current!);
	React.useEffect(() => {
		if (restoreTimer.current !== null) {
			window.clearTimeout(restoreTimer.current);
			restoreTimer.current = null;
		}
		const first = overlayRef.current?.querySelector<HTMLElement>(
			'[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
		);
		(
			first ?? overlayRef.current?.querySelector<HTMLElement>('[role="dialog"]')
		)?.focus();
		return () => {
			restoreTimer.current = window.setTimeout(() => {
				previousFocus.current?.focus();
				restoreTimer.current = null;
			}, 0);
		};
	}, []);

	return (
		<div
			ref={overlayRef}
			className={cn(
				"fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
				className,
			)}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (event.defaultPrevented) return;
				if (event.key === "Escape") {
					if (onEscape) {
						event.preventDefault();
						onEscape();
					}
					return;
				}
				if (event.key !== "Tab") return;
				const dialog =
					event.currentTarget.querySelector<HTMLElement>('[role="dialog"]');
				const focusable = Array.from(
					dialog?.querySelectorAll<HTMLElement>(
						'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
					) ?? [],
				).filter(
					(element) =>
						!element.hasAttribute("hidden") &&
						element.getAttribute("aria-hidden") !== "true",
				);
				if (focusable.length === 0) {
					event.preventDefault();
					dialog?.focus();
					return;
				}
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (!first || !last) return;
				if (
					event.shiftKey &&
					(document.activeElement === first ||
						!dialog?.contains(document.activeElement))
				) {
					event.preventDefault();
					last.focus();
				} else if (
					!event.shiftKey &&
					(document.activeElement === last ||
						!dialog?.contains(document.activeElement))
				) {
					event.preventDefault();
					first.focus();
				}
			}}
			{...props}
		/>
	);
});
DialogOverlay.displayName = "DialogOverlay";

export interface DialogContentProps
	extends React.HTMLAttributes<HTMLDivElement> {}

export const DialogContent = React.forwardRef<
	HTMLDivElement,
	DialogContentProps
>(({ className, tabIndex = -1, ...props }, ref) => (
	<div
		ref={ref}
		tabIndex={tabIndex}
		className={cn(
			"max-h-[calc(100vh-2rem)] w-full overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg",
			className,
		)}
		{...props}
	/>
));
DialogContent.displayName = "DialogContent";
