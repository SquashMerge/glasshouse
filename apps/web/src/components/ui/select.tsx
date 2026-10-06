import * as React from "react";
import { LuChevronDown } from "react-icons/lu";
import { cn } from "../../lib/utils";

export interface SelectProps
	extends React.SelectHTMLAttributes<HTMLSelectElement> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
	({ className, disabled, ...props }, ref) => {
		const widthClasses = className
			?.split(/\s+/)
			.filter((token) => /(^|:)w-/.test(token))
			.join(" ");

		return (
			<span className={cn("relative inline-flex w-full", widthClasses)}>
				<select
					ref={ref}
					className={cn(
						"flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
						className,
					)}
					disabled={disabled}
					{...props}
				/>
				<LuChevronDown
					className={cn(
						"pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground",
						disabled && "opacity-50",
					)}
					data-testid="select-chevron"
					aria-hidden="true"
				/>
			</span>
		);
	},
);
Select.displayName = "Select";

export { Select };
