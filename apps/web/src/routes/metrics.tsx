import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { listMetrics, type MetricRow } from "../lib/metrics-api";

export function MetricsPage() {
	const { selectedProjectId } = useProjectSelection();
	return selectedProjectId ? (
		<ProjectMetrics key={selectedProjectId} projectId={selectedProjectId} />
	) : (
		<p className="text-muted-foreground">
			Select a Project to inspect metrics.
		</p>
	);
}

function ProjectMetrics({ projectId }: { projectId: string }) {
	const [input, setInput] = useState("");
	const [name, setName] = useState("");
	const [cursor, setCursor] = useState<string | null>(null);
	const query = useQuery({
		queryKey: ["metrics", projectId, name, cursor],
		queryFn: ({ signal }) => listMetrics(projectId, name, cursor, signal),
	});
	return (
		<div className="min-w-0 space-y-6">
			<PageHeader
				title="Metrics"
				description="Retained OTLP data points for the selected Project. Original aggregation and exact nanosecond timestamps are preserved."
			/>
			<form
				className="flex flex-wrap items-end gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					setName(input);
					setCursor(null);
				}}
			>
				<div className="grid min-w-0 flex-1 gap-2">
					<Label htmlFor="metric-name">Metric name (exact match)</Label>
					<Input
						id="metric-name"
						value={input}
						maxLength={1024}
						onChange={(event) => setInput(event.target.value)}
						placeholder="All metric names"
					/>
				</div>
				<Button type="submit">Apply filter</Button>
				<Button
					type="button"
					variant="outline"
					disabled={query.isFetching}
					onClick={() => {
						if (cursor) setCursor(null);
						else void query.refetch();
					}}
				>
					Refresh metrics
				</Button>
			</form>
			{query.isPending ? (
				<p role="status">Loading metrics…</p>
			) : query.isError ? (
				<div role="alert" className="space-y-3 text-sm">
					<p>
						Metrics could not be loaded. Check your Project access and retry.
					</p>
					<Button variant="outline" onClick={() => void query.refetch()}>
						Retry metrics
					</Button>
				</div>
			) : query.data.items.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>No metric points</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm text-muted-foreground">
						<p>
							Configure an OTLP metrics exporter with the API base endpoint, an
							ingestion credential, and this Project’s x-glasshouse-project-id
							header.
						</p>
						<p>
							HTTP exporters send to /v1/metrics. gRPC exporters use the
							optional MetricsService listener.
						</p>
					</CardContent>
				</Card>
			) : (
				<section className="space-y-4" aria-label="Metric data points">
					<p className="text-sm text-muted-foreground">
						{query.data.items.length} points on this page, newest first. Values
						are raw observations; delta and cumulative snapshots are not added
						together.
					</p>
					{query.data.items.map((row, index) => (
						<MetricCard key={`${row.point_id}:${index}`} row={row} />
					))}
				</section>
			)}
			<div className="flex flex-wrap gap-3">
				{cursor ? (
					<Button variant="outline" onClick={() => setCursor(null)}>
						Newest points
					</Button>
				) : null}
				{!query.isError && query.data?.next_cursor ? (
					<Button
						variant="outline"
						disabled={query.isFetching}
						onClick={() => setCursor(query.data?.next_cursor ?? null)}
					>
						Older points
					</Button>
				) : null}
			</div>
		</div>
	);
}

function MetricCard({ row }: { row: MetricRow }) {
	const point = row.data_point;
	const value = point.asInt ?? point.asDouble;
	const temporality =
		row.aggregation_temporality === 1
			? "Delta"
			: row.aggregation_temporality === 2
				? "Cumulative"
				: "No temporality";
	return (
		<Card className="min-w-0">
			<CardHeader className="space-y-2">
				<CardTitle className="break-all text-lg">{row.name}</CardTitle>
				<p className="text-sm text-muted-foreground">
					{row.metric_type.replaceAll("_", " ")} · {temporality}
					{row.metric_type === "sum"
						? row.is_monotonic
							? " · Monotonic"
							: " · Non-monotonic"
						: ""}{" "}
					· Unit: {row.unit || "unspecified"}
				</p>
			</CardHeader>
			<CardContent className="space-y-4">
				<dl className="grid gap-3 text-sm sm:grid-cols-2">
					<div>
						<dt className="text-muted-foreground">Unix time (nanoseconds)</dt>
						<dd className="break-all font-mono">{row.time_unix_nano}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Value</dt>
						<dd className="break-all font-mono">
							{Number(point.flags ?? 0) & 1
								? "No recorded value"
								: value !== undefined
									? String(value)
									: `Count ${String(point.count ?? "0")}; sum ${String(point.sum ?? "not reported")}`}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Instrumentation scope</dt>
						<dd className="break-all">
							{row.scope_name || "Unknown"} {row.scope_version}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Series ID</dt>
						<dd className="break-all font-mono text-xs">{row.series_id}</dd>
					</div>
				</dl>
				<details className="rounded-md border border-border p-3">
					<summary className="cursor-pointer rounded-sm text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						Inspect exact point and attributes
					</summary>
					<pre
						tabIndex={0}
						aria-label={`OTLP data for ${row.name}`}
						className="mt-4 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
					>
						{JSON.stringify(row, null, 2)}
					</pre>
				</details>
			</CardContent>
		</Card>
	);
}
