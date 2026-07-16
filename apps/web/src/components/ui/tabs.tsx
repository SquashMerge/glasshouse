import * as React from "react";
import { cn } from "../../lib/utils";

interface TabsContextValue {
	value: string;
	setValue: (v: string) => void;
}
const TabsContext = React.createContext<TabsContextValue>({
	value: "",
	setValue: () => {},
});

function Tabs({
	value,
	onValueChange,
	children,
	className,
}: {
	value: string;
	onValueChange: (v: string) => void;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<TabsContext.Provider value={{ value, setValue: onValueChange }}>
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
>(({ className, value, ...props }, ref) => {
	const ctx = React.useContext(TabsContext);
	const active = ctx.value === value;
	return (
		<button
			ref={ref}
			role="tab"
			type="button"
			aria-selected={active}
			onClick={() => ctx.setValue(value)}
			className={cn(
				"inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all",
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
>(({ className, value, ...props }, ref) => {
	const ctx = React.useContext(TabsContext);
	if (ctx.value !== value) return null;
	return (
		<div
			ref={ref}
			role="tabpanel"
			className={cn("mt-3", className)}
			{...props}
		/>
	);
});
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
