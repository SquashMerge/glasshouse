import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LuLoader, LuSearchX } from "react-icons/lu";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table";
import { listAuditEvents, type AuditEvent } from "../lib/api";

type Filters = {
	from: string;
	to: string;
	actor: string;
	action: string;
	resource: string;
	outcome: string;
	search: string;
};

const emptyFilters: Filters = {
	from: "",
	to: "",
	actor: "",
	action: "",
	resource: "",
	outcome: "",
	search: "",
};

function asIso(value: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function displayTime(value: string): string {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
	return `${new Date(value).toLocaleString()} (${timeZone})`;
}

export function AuditLogPage() {
	const [filters, setFilters] = React.useState<Filters>(emptyFilters);
	const [debounced, setDebounced] = React.useState<Filters>(filters);
	React.useEffect(() => {
		const timeout = window.setTimeout(() => setDebounced(filters), 250);
		return () => window.clearTimeout(timeout);
	}, [filters]);
	const from = asIso(filters.from);
	const to = asIso(filters.to);
	const rangeError =
		from && to && from > to
			? "The start time must be before the end time."
			: null;
	const showResults =
		!rangeError &&
		filters.from === debounced.from &&
		filters.to === debounced.to;

	const params = React.useMemo(
		() => ({
			from: asIso(debounced.from),
			to: asIso(debounced.to),
			actor: debounced.actor || undefined,
			action: debounced.action || undefined,
			resource: debounced.resource || undefined,
			outcome: debounced.outcome || undefined,
			search: debounced.search || undefined,
		}),
		[debounced],
	);
	const query = useInfiniteQuery({
		queryKey: ["audit-events", params],
		enabled: showResults,
		queryFn: ({ pageParam }) =>
			listAuditEvents({ ...params, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor,
		gcTime: 0,
		staleTime: 0,
	});
	const events = React.useMemo(() => {
		const seen = new Set<string>();
		const result: AuditEvent[] = [];
		for (const page of query.data?.pages ?? []) {
			for (const event of page.items) {
				const key = `${event.source}:${event.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				result.push(event);
			}
		}
		return result;
	}, [query.data]);
	const sentinel = React.useRef<HTMLDivElement>(null);
	const loadMore = React.useCallback(() => {
		if (showResults && query.hasNextPage && !query.isFetchingNextPage)
			void query.fetchNextPage();
	}, [
		query.fetchNextPage,
		query.hasNextPage,
		query.isFetchingNextPage,
		showResults,
	]);
	React.useEffect(() => {
		const node = sentinel.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry?.isIntersecting) loadMore();
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [loadMore]);

	function update(name: keyof Filters, value: string) {
		setFilters((current) => ({ ...current, [name]: value }));
	}
	const hasFilters = Object.values(filters).some(Boolean);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Audit log"
				description="Read-only, content-free history of retained user actions you are allowed to inspect."
			/>
			<Card>
				<CardContent className="space-y-4 pt-6">
					<fieldset className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						<legend className="mb-2 text-sm font-medium">Filters</legend>
						<FilterInput
							label="From"
							type="datetime-local"
							value={filters.from}
							invalid={!!rangeError}
							describedBy={
								rangeError
									? "audit-time-zone audit-time-error"
									: "audit-time-zone"
							}
							onChange={(value) => update("from", value)}
						/>
						<FilterInput
							label="To"
							type="datetime-local"
							value={filters.to}
							invalid={!!rangeError}
							describedBy={
								rangeError
									? "audit-time-zone audit-time-error"
									: "audit-time-zone"
							}
							onChange={(value) => update("to", value)}
						/>
						<FilterInput
							label="Actor"
							value={filters.actor}
							onChange={(value) => update("actor", value)}
						/>
						<FilterInput
							label="Action"
							value={filters.action}
							onChange={(value) => update("action", value)}
						/>
						<FilterInput
							label="Resource"
							value={filters.resource}
							onChange={(value) => update("resource", value)}
						/>
						<FilterInput
							label="Outcome"
							value={filters.outcome}
							onChange={(value) => update("outcome", value)}
						/>
						<FilterInput
							label="Search"
							value={filters.search}
							onChange={(value) => update("search", value)}
							className="xl:col-span-2"
						/>
					</fieldset>
					<p id="audit-time-zone" className="text-xs text-muted-foreground">
						Dates use your local time zone (
						{Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local"}).
					</p>
					{rangeError && (
						<p
							id="audit-time-error"
							role="alert"
							className="text-xs text-destructive"
						>
							{rangeError}
						</p>
					)}
					{hasFilters && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setFilters(emptyFilters)}
						>
							Clear filters
						</Button>
					)}
					{showResults && query.isError && (
						<div
							role="alert"
							className="flex items-center justify-between gap-3 text-sm text-destructive"
						>
							<span>Failed to load: {(query.error as Error).message}</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void query.refetch()}
							>
								Retry
							</Button>
						</div>
					)}
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Time</TableHead>
									<TableHead>Actor</TableHead>
									<TableHead>Action</TableHead>
									<TableHead>Resource</TableHead>
									<TableHead>Outcome</TableHead>
									<TableHead>Details</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{!showResults ? null : query.isLoading ? (
									<TableRow>
										<TableCell
											colSpan={6}
											className="text-center text-muted-foreground"
										>
											Loading audit events…
										</TableCell>
									</TableRow>
								) : events.length === 0 && !query.isError ? (
									<TableRow>
										<TableCell
											colSpan={6}
											className="text-center text-muted-foreground"
										>
											{hasFilters ? (
												<span className="inline-flex items-center gap-2">
													<LuSearchX className="h-4 w-4" />
													No audit events match the current filters.
												</span>
											) : (
												"No retained audit events are available."
											)}
										</TableCell>
									</TableRow>
								) : (
									events.map((event) => (
										<AuditRow
											key={`${event.source}:${event.id}`}
											event={event}
										/>
									))
								)}
							</TableBody>
						</Table>
					</div>
					<div ref={sentinel} aria-hidden="true" />
					{showResults &&
						(query.hasNextPage ? (
							<Button
								type="button"
								variant="outline"
								onClick={loadMore}
								disabled={query.isFetchingNextPage}
								aria-label="Load more audit events"
							>
								{query.isFetchingNextPage ? (
									<>
										<LuLoader className="h-4 w-4 animate-spin" />
										Loading more…
									</>
								) : (
									"Load more"
								)}
							</Button>
						) : (
							events.length > 0 && (
								<p className="text-sm text-muted-foreground" role="status">
									End of retained audit events.
								</p>
							)
						))}
				</CardContent>
			</Card>
		</div>
	);
}

function FilterInput({
	label,
	value,
	onChange,
	type = "search",
	className,
	invalid,
	describedBy,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: string;
	className?: string;
	invalid?: boolean;
	describedBy?: string;
}) {
	const id = `audit-filter-${label.toLowerCase()}`;
	return (
		<label
			htmlFor={id}
			className={`grid gap-1 text-sm font-medium ${className ?? ""}`}
		>
			<span>{label}</span>
			<Input
				id={id}
				type={type}
				value={value}
				aria-invalid={invalid || undefined}
				aria-describedby={describedBy}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

function AuditRow({ event }: { event: AuditEvent }) {
	return (
		<TableRow>
			<TableCell className="whitespace-nowrap font-mono text-xs">
				{displayTime(event.created_at)}
			</TableCell>
			<TableCell>{event.actor || "Unavailable"}</TableCell>
			<TableCell>{event.action}</TableCell>
			<TableCell>
				{event.resource_type}
				{event.resource_id ? ` · ${event.resource_id}` : ""}
			</TableCell>
			<TableCell>{event.outcome ?? "Unavailable"}</TableCell>
			<TableCell>
				<details>
					<summary className="cursor-pointer text-sm underline">
						Safe details
					</summary>
					<p className="mt-1 text-xs text-muted-foreground">
						Source: {event.details.source}
					</p>
				</details>
			</TableCell>
		</TableRow>
	);
}
