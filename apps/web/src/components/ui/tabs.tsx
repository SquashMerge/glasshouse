import * as React from "react";
import { cn } from "../../lib/utils";

interface TabsContextValue {
	value: string;
	setValue: (v: string) => void | Promise<void>;
	id: string;
}
const TabsContext = React.createContext<TabsContextValue>({
	value: "",
	setValue: () => {},
	id: "tabs",
});

function Tabs({
	value,
	onValueChange,
	children,
	className,
}: {
	value: string;
	onValueChange: (v: string) => void | Promise<void>;
	children: React.ReactNode;
	className?: string;
}) {
	const id = React.useId();
	return (
		<TabsContext.Provider value={{ value, setValue: onValueChange, id }}>
			<div className={className}>{children}</div>
		</TabsContext.Provider>
	);
}

const TabsList = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		role="tablist"
		className={cn(
			"inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
			className,
		)}
		{...props}
	/>
));
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<
	HTMLButtonElement,
	React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }
>(({ className, value, onClick, onKeyDown, ...props }, ref) => {
	const ctx = React.useContext(TabsContext);
	const active = ctx.value === value;
	return (
		<button
			ref={ref}
			id={`${ctx.id}-tab-${value}`}
			role="tab"
			type="button"
			aria-selected={active}
			aria-controls={`${ctx.id}-panel-${value}`}
			tabIndex={active ? 0 : -1}
			onClick={(event) => {
				const trigger = event.currentTarget;
				const hadFocus = document.activeElement === trigger;
				void Promise.resolve(ctx.setValue(value)).then(() => {
					// URL-backed selection can reset focus after the route commits.
					if (
						hadFocus &&
						trigger.isConnected &&
						(document.activeElement === document.body ||
							document.activeElement === trigger)
					)
						trigger.focus();
				});
				onClick?.(event);
			}}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (event.defaultPrevented) return;
				const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
				const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
				if (
					!backward &&
					!forward &&
					event.key !== "Home" &&
					event.key !== "End"
				)
					return;
				const list = event.currentTarget.closest('[role="tablist"]');
				if (!list) return;
				const tabs = Array.from(
					list.querySelectorAll<HTMLButtonElement>(
						'[role="tab"]:not(:disabled)',
					),
				);
				const currentIndex = tabs.indexOf(event.currentTarget);
				const nextIndex =
					event.key === "Home"
						? 0
						: event.key === "End"
							? tabs.length - 1
							: (currentIndex + (backward ? tabs.length - 1 : 1)) % tabs.length;
				const next = tabs[nextIndex];
				if (!next) return;
				event.preventDefault();
				next.focus();
				next.click();
			}}
			className={cn(
				"inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				active
					? "bg-background text-foreground shadow"
					: "text-muted-foreground hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
});
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement> & { value: string }
>(({ className, value, children, ...props }, ref) => {
	const ctx = React.useContext(TabsContext);
	const active = ctx.value === value;
	return (
		<div
			ref={ref}
			id={`${ctx.id}-panel-${value}`}
			aria-labelledby={`${ctx.id}-tab-${value}`}
			role="tabpanel"
			tabIndex={0}
			hidden={!active}
			className={cn("mt-3", className)}
			{...props}
		>
			{active ? children : null}
		</div>
	);
});
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
