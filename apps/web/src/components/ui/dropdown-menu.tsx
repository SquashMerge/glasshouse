import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

interface DropdownMenuContextValue {
	open: boolean;
	setOpen: React.Dispatch<React.SetStateAction<boolean>>;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
}
const DropdownMenuContext = React.createContext<DropdownMenuContextValue>({
	open: false,
	setOpen: () => {},
	triggerRef: { current: null },
});

function DropdownMenu({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement | null>(null);
	return (
		<DropdownMenuContext.Provider value={{ open, setOpen, triggerRef }}>
			{children}
		</DropdownMenuContext.Provider>
	);
}

function DropdownMenuTrigger({
	children,
	asChild: _asChild,
	className,
	onClick,
	onKeyDown,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
	const ctx = React.useContext(DropdownMenuContext);
	return (
		<button
			type="button"
			ref={ctx.triggerRef}
			onClick={(event) => {
				onClick?.(event);
				if (!event.defaultPrevented) ctx.setOpen((open) => !open);
			}}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (event.defaultPrevented || event.key !== "ArrowDown" || ctx.open)
					return;
				event.preventDefault();
				ctx.setOpen(true);
			}}
			aria-haspopup="menu"
			aria-expanded={ctx.open}
			className={className}
			{...props}
		>
			{children}
		</button>
	);
}

const VIEWPORT_GUTTER = 4;
const MIN_MENU_WIDTH = 160; // matches `min-w-[10rem]` in className

function DropdownMenuContent({
	children,
	align = "end",
	side = "bottom",
	sideOffset = 6,
	className,
}: {
	children: React.ReactNode;
	align?: "start" | "end";
	side?: "top" | "bottom";
	sideOffset?: number;
	className?: string;
}) {
	const ctx = React.useContext(DropdownMenuContext);
	const contentRef = React.useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = React.useState<{ top: number; left: number } | null>(
		null,
	);

	React.useLayoutEffect(() => {
		if (!ctx.open) return;
		const trigger = ctx.triggerRef.current;
		if (!trigger) return;

		const update = () => {
			const r = trigger.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;

			const measuredW = contentRef.current?.offsetWidth ?? 0;
			const menuW = Math.max(measuredW, MIN_MENU_WIDTH);
			const menuH = contentRef.current?.offsetHeight ?? 0;

			const spaceBelow = vh - r.bottom - sideOffset;
			const spaceAbove = r.top - sideOffset;
			const wantsBottom = side === "bottom";
			const openBelow =
				wantsBottom === (spaceBelow >= menuH || spaceBelow >= spaceAbove);
			const top = openBelow
				? Math.min(r.bottom + sideOffset, vh - menuH - VIEWPORT_GUTTER)
				: Math.max(r.top - sideOffset - menuH, VIEWPORT_GUTTER);

			const desiredLeft = align === "end" ? r.right - menuW : r.left;
			const left = Math.max(
				VIEWPORT_GUTTER,
				Math.min(desiredLeft, vw - menuW - VIEWPORT_GUTTER),
			);

			setPos({ top, left });
		};

		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [ctx.open, ctx.triggerRef, align, side, sideOffset]);

	React.useEffect(() => {
		if (!ctx.open) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (contentRef.current?.contains(t)) return;
			if (ctx.triggerRef.current?.contains(t)) return;
			ctx.setOpen(false);
			if (
				t instanceof Element &&
				t.closest(
					'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
				)
			)
				return;
			ctx.triggerRef.current?.focus();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") ctx.setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [ctx.open, ctx.setOpen, ctx.triggerRef]);

	React.useEffect(() => {
		if (!ctx.open) return;
		contentRef.current
			?.querySelector<HTMLElement>('[role^="menuitem"]')
			?.focus();
	}, [ctx.open]);

	function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			ctx.setOpen(false);
			ctx.triggerRef.current?.focus();
			return;
		}

		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

		const items = Array.from(
			contentRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
				[],
		).filter((item) => item.getAttribute("aria-disabled") !== "true");
		if (items.length === 0) return;

		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: event.key === "ArrowUp"
						? (current - 1 + items.length) % items.length
						: (current + 1) % items.length;
		const nextItem = items[next];
		nextItem?.focus();
		nextItem?.scrollIntoView?.({ block: "nearest" });
	}

	if (!ctx.open) return null;
	if (typeof document === "undefined") return null;

	const style: React.CSSProperties = pos
		? { top: pos.top, left: pos.left }
		: { top: 0, left: 0, visibility: "hidden" };

	return createPortal(
		<div
			ref={contentRef}
			role="menu"
			onKeyDown={moveFocus}
			style={style}
			className={cn(
				"fixed z-50 max-h-[calc(100vh-0.5rem)] min-w-[10rem] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
				className,
			)}
		>
			{children}
		</div>,
		document.body,
	);
}

function DropdownMenuItem({
	children,
	className,
	onSelect,
	...props
}: React.HTMLAttributes<HTMLDivElement> & { onSelect?: () => void }) {
	const ctx = React.useContext(DropdownMenuContext);
	function select() {
		onSelect?.();
		ctx.setOpen(false);
		ctx.triggerRef.current?.focus();
	}
	return (
		<div
			role="menuitem"
			tabIndex={0}
			onClick={select}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					select();
				}
			}}
			className={cn(
				"relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

function DropdownMenuSeparator({ className }: { className?: string }) {
	return (
		<div
			role="separator"
			className={cn("-mx-1 my-1 h-px bg-border", className)}
		/>
	);
}

function DropdownMenuLabel({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"px-2 py-1.5 text-xs font-semibold text-muted-foreground",
				className,
			)}
		>
			{children}
		</div>
	);
}

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuLabel,
};
