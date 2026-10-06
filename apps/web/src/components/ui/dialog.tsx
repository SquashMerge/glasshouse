import * as React from "react";
import { cn } from "../../lib/utils";

export interface DialogOverlayProps
	extends React.HTMLAttributes<HTMLDivElement> {}

export const DialogOverlay = React.forwardRef<
	HTMLDivElement,
	DialogOverlayProps
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn(
			"fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
			className,
		)}
		{...props}
	/>
));
DialogOverlay.displayName = "DialogOverlay";

export interface DialogContentProps
	extends React.HTMLAttributes<HTMLDivElement> {}

export const DialogContent = React.forwardRef<
	HTMLDivElement,
	DialogContentProps
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn(
			"max-h-[calc(100vh-2rem)] w-full overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg",
			className,
		)}
		{...props}
	/>
));
DialogContent.displayName = "DialogContent";
