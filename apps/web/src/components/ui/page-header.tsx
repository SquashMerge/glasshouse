import type { ReactNode } from "react";

export function PageHeader({
	title,
	description,
}: {
	title: string;
	description?: ReactNode;
}) {
	return (
		<header className="space-y-1">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{description ? (
				<p className="text-sm text-muted-foreground">{description}</p>
			) : null}
		</header>
	);
}
