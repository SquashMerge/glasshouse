import { Card, CardContent } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

/**
 * Initial data loads use a layout-shaped skeleton while the page shell and any
 * independent actions remain visible. Do not render this when usable data is
 * already present during a refetch; keep that data visible instead.
 */
export function ListLoadingSkeleton({
	testId,
	rows = 5,
	className = "",
}: {
	testId: string;
	rows?: number;
	className?: string;
}) {
	return (
		<Card data-testid={testId} aria-busy="true" aria-label="Loading content">
			<CardContent className={`p-0 ${className}`}>
				<div className="hidden grid-cols-4 gap-4 border-b px-4 py-3 md:grid">
					<Skeleton className="h-3 w-2/3" />
					<Skeleton className="h-3 w-3/4" />
					<Skeleton className="h-3 w-1/2" />
					<Skeleton className="h-3 w-2/3" />
				</div>
				<div className="divide-y divide-border">
					{Array.from({ length: rows }, (_, index) => (
						<div
							key={index}
							className="grid gap-2 px-4 py-4 md:grid-cols-4 md:items-center md:gap-4"
						>
							<div className="space-y-2">
								<Skeleton className="h-4 w-3/4" />
								<Skeleton className="h-3 w-1/2" />
							</div>
							<Skeleton className="h-4 w-12" />
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-4 w-20" />
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

export function DetailLoadingSkeleton({ testId }: { testId: string }) {
	return (
		<div className="space-y-6" data-testid={testId} aria-busy="true">
			<div className="space-y-2">
				<Skeleton className="h-8 w-56" />
				<Skeleton className="h-4 w-40" />
			</div>
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
				<Card>
					<CardContent className="space-y-4 p-6">
						<Skeleton className="h-5 w-32" />
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-24 w-full" />
					</CardContent>
				</Card>
				<Card>
					<CardContent className="space-y-3 p-6">
						<Skeleton className="h-5 w-24" />
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-full" />
					</CardContent>
				</Card>
			</div>
		</div>
	);
}

export function FormLoadingSkeleton({ testId }: { testId: string }) {
	return (
		<div className="space-y-6" data-testid={testId} aria-busy="true">
			<div className="space-y-2">
				<Skeleton className="h-8 w-56" />
				<Skeleton className="h-4 w-72" />
			</div>
			<Card>
				<CardContent className="space-y-5 p-6">
					<Skeleton className="h-5 w-28" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-5 w-32" />
					<Skeleton className="h-28 w-full" />
					<Skeleton className="h-9 w-28" />
				</CardContent>
			</Card>
		</div>
	);
}
