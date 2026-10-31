import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { LuCopy, LuExternalLink } from "react-icons/lu";
import { HealthBadge } from "../components/HealthBadge";
import { useProjectSelection } from "../components/ProjectProvider";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { Label } from "../components/ui/label";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton } from "../components/ui/skeleton";
import { copyText } from "../lib/clipboard";
import {
	getOrganizationUsage,
	type OrganizationUsageDashboard,
	type OrganizationUsageRange,
} from "../lib/api";

const ranges: Array<{ value: OrganizationUsageRange; label: string }> = [
	{ value: "24h", label: "24 hours" },
	{ value: "7d", label: "7 days" },
	{ value: "30d", label: "30 days" },
	{ value: "90d", label: "90 days" },
];
const numberFormat = new Intl.NumberFormat();
const formatCount = (count: number) => numberFormat.format(count);

type UsageBucket = OrganizationUsageDashboard["series"][number];

function otlpSetup(projectId: string | null): string {
	return `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/v1/otel
export GLASSHOUSE_PROJECT_ID="${projectId ?? "<project-uuid>"}"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic <base64(username:password)>,x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
export OTEL_SERVICE_NAME=my-agent`;
}

function UsageBars({ series }: { series: UsageBucket[] }) {
	const maxValue = Math.max(
		1,
		...series.map((bucket) => bucket.traces + bucket.observations),
	);
	return (
		<div
			className="flex h-40 items-end gap-1 overflow-x-auto border-b border-l border-border px-2 pb-1"
			role="img"
			aria-label={`Persisted telemetry trend with ${series.length} UTC time buckets`}
		>
			{series.map((bucket) => {
				const date = new Date(bucket.bucket_start);
				return (
					<div
						key={bucket.bucket_start}
						className="flex h-full min-w-1 flex-1 items-end gap-px"
						title={`${date.toLocaleString("en", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC · ${formatCount(bucket.traces)} traces · ${formatCount(bucket.observations)} observations`}
					>
						<div
							className="flex-1 rounded-t-sm bg-primary/90"
							style={{ height: `${(bucket.traces / maxValue) * 100}%` }}
						/>
						<div
							className="flex-1 rounded-t-sm bg-accent"
							style={{ height: `${(bucket.observations / maxValue) * 100}%` }}
						/>
					</div>
				);
			})}
		</div>
	);
}

export function DashboardPage() {
	const { selectedProjectId } = useProjectSelection();
	const [range, setRange] = React.useState<OrganizationUsageRange>("30d");
	const [copyState, setCopyState] = React.useState<
		"idle" | "copied" | "failed"
	>("idle");
	const usage = useQuery({
		queryKey: ["organization-usage", range],
		queryFn: () => getOrganizationUsage(range),
	});
	const data = usage.data;
	const hasUsage =
		(data?.totals.traces ?? 0) > 0 || (data?.totals.observations ?? 0) > 0;

	async function copyOtlpSetup() {
		const result = await copyText(otlpSetup(selectedProjectId));
		setCopyState(result.ok ? "copied" : "failed");
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-5">
				<PageHeader
					title="Organization overview"
					description={
						<span className="block max-w-3xl">
							Usage across every active and archived Project in your
							organization. Counts are retained rows grouped by record start
							time; this view does not grant access to telemetry details.
						</span>
					}
				/>
				<div className="grid gap-2">
					<Label htmlFor="usage-time-range">Time range (UTC)</Label>
					<Select
						id="usage-time-range"
						aria-label="Usage time range"
						value={range}
						onChange={(event) =>
							setRange(event.target.value as OrganizationUsageRange)
						}
					>
						{ranges.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</Select>
				</div>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="space-y-1 text-sm text-muted-foreground">
					{data && (
						<p>
							Data through{" "}
							<time dateTime={data.to}>
								{new Date(data.to)
									.toISOString()
									.replace("T", " ")
									.replace("Z", " UTC")}
							</time>
						</p>
					)}
					<p className="text-xs">
						Query range end, not an ingestion watermark or last update time.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					aria-disabled={usage.isFetching}
					aria-busy={usage.isFetching}
					onClick={() => {
						if (!usage.isFetching) void usage.refetch();
					}}
				>
					Refresh usage
				</Button>
			</div>
			<section aria-label="Service health">
				<Card>
					<CardContent className="p-5 pt-5">
						<p className="text-sm font-medium text-muted-foreground">
							Service health
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Dependency availability, separate from telemetry activity.
						</p>
						<div className="mt-3">
							<HealthBadge />
						</div>
					</CardContent>
				</Card>
			</section>

			{usage.isError && (
				<Card role="alert">
					<CardContent className="p-5 pt-5">
						<p className="font-medium">Could not load organization usage.</p>
						<p className="mt-1 text-sm text-muted-foreground">
							Try again. Your organization and Project access have not changed.
						</p>
						<Button
							className="mt-4"
							size="sm"
							onClick={() => void usage.refetch()}
						>
							Retry
						</Button>
					</CardContent>
				</Card>
			)}

			{usage.isPending ? (
				<section
					aria-label="Usage summary"
					className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3"
					aria-busy="true"
				>
					{Array.from({ length: 3 }, (_, index) => (
						<Skeleton key={index} className="h-28" />
					))}
				</section>
			) : (
				data && (
					<>
						<section
							aria-label="Usage summary"
							className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3"
						>
							<Card>
								<CardContent className="p-5 pt-5">
									<p className="text-sm font-medium text-muted-foreground">
										Traces retained
									</p>
									<strong className="mt-2 block text-2xl font-semibold tabular-nums">
										{formatCount(data.totals.traces)}
									</strong>
									<p className="mt-1 text-xs text-muted-foreground">
										Rows in this range
									</p>
								</CardContent>
							</Card>
							<Card>
								<CardContent className="p-5 pt-5">
									<p className="text-sm font-medium text-muted-foreground">
										Observations retained
									</p>
									<strong className="mt-2 block text-2xl font-semibold tabular-nums">
										{formatCount(data.totals.observations)}
									</strong>
									<p className="mt-1 text-xs text-muted-foreground">
										Span, event, generation, and tool rows
									</p>
								</CardContent>
							</Card>
							<Card>
								<CardContent className="p-5 pt-5">
									<p className="text-sm font-medium text-muted-foreground">
										Projects included
									</p>
									<strong className="mt-2 block text-2xl font-semibold tabular-nums">
										{formatCount(data.projects.length)}
									</strong>
									<p className="mt-1 text-xs text-muted-foreground">
										Active and archived
									</p>
								</CardContent>
							</Card>
						</section>

						<Card>
							<CardContent className="space-y-5 p-5 pt-5">
								<div>
									<h2 className="font-semibold">Telemetry activity</h2>
									<p className="mt-1 text-sm text-muted-foreground">
										Traces and observations by UTC{" "}
										{range === "24h" ? "hour" : "day"}. Empty buckets are shown
										as zero.
									</p>
								</div>
								<UsageBars series={data.series} />
								<div className="sr-only">
									<table>
										<caption>Telemetry activity by UTC time bucket</caption>
										<thead>
											<tr>
												<th scope="col">Bucket start (UTC)</th>
												<th scope="col">Traces</th>
												<th scope="col">Observations</th>
											</tr>
										</thead>
										<tbody>
											{data.series.map((bucket) => (
												<tr key={bucket.bucket_start}>
													<th scope="row">{bucket.bucket_start}</th>
													<td>{formatCount(bucket.traces)}</td>
													<td>{formatCount(bucket.observations)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
								<div
									className="flex flex-wrap gap-4 text-xs text-muted-foreground"
									aria-label="Chart legend"
								>
									<span className="inline-flex items-center gap-2">
										<span className="size-2 rounded-sm bg-primary/90" />
										Traces
									</span>
									<span className="inline-flex items-center gap-2">
										<span className="size-2 rounded-sm bg-accent" />
										Observations
									</span>
								</div>
							</CardContent>
						</Card>

						<section
							aria-label="Project usage"
							className="grid grid-cols-1 gap-6"
						>
							<Card>
								<CardContent className="space-y-4 p-5 pt-5">
									<div>
										<h2 className="font-semibold">Project usage</h2>
										<p className="mt-1 text-sm text-muted-foreground">
											Persisted rows in the selected range. Archived Projects
											retain historical usage while their telemetry remains
											stored.
										</p>
									</div>
									{data.projects.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No active or archived Projects to report.
										</p>
									) : (
										<div className="overflow-x-auto">
											<table className="w-full min-w-[760px] border-collapse text-left text-sm">
												<thead>
													<tr className="border-b border-border text-xs text-muted-foreground">
														<th className="px-3 py-3 font-medium">Project</th>
														<th className="px-3 py-3 font-medium">Status</th>
														<th className="px-3 py-3 text-right font-medium">
															Traces
														</th>
														<th className="px-3 py-3 text-right font-medium">
															Observations
														</th>
														<th className="px-3 py-3 font-medium">
															Observation types
														</th>
													</tr>
												</thead>
												<tbody className="divide-y divide-border">
													{data.projects.map((project) => (
														<tr key={project.id}>
															<th scope="row" className="px-3 py-3 font-medium">
																{project.name}
																<span className="ml-2 font-mono text-xs text-muted-foreground">
																	{project.slug}
																</span>
															</th>
															<td className="px-3 py-3">
																{project.status === "archived"
																	? "Archived"
																	: "Active"}
															</td>
															<td className="px-3 py-3 text-right tabular-nums">
																{formatCount(project.traces)}
															</td>
															<td className="px-3 py-3 text-right tabular-nums">
																{formatCount(project.observations)}
															</td>
															<td className="px-3 py-3 text-xs text-muted-foreground">
																span{" "}
																{formatCount(project.observations_by_type.span)}{" "}
																· event{" "}
																{formatCount(
																	project.observations_by_type.event,
																)}{" "}
																· generation{" "}
																{formatCount(
																	project.observations_by_type.generation,
																)}{" "}
																· tool{" "}
																{formatCount(project.observations_by_type.tool)}
															</td>
														</tr>
													))}
													<tr className="border-t-2 border-border font-semibold">
														<th scope="row" className="px-3 py-3">
															Organization total
														</th>
														<td className="px-3 py-3">—</td>
														<td className="px-3 py-3 text-right tabular-nums">
															{formatCount(data.totals.traces)}
														</td>
														<td className="px-3 py-3 text-right tabular-nums">
															{formatCount(data.totals.observations)}
														</td>
														<td className="px-3 py-3 text-xs font-normal text-muted-foreground">
															span{" "}
															{formatCount(
																data.totals.observations_by_type.span,
															)}{" "}
															· event{" "}
															{formatCount(
																data.totals.observations_by_type.event,
															)}{" "}
															· generation{" "}
															{formatCount(
																data.totals.observations_by_type.generation,
															)}{" "}
															· tool{" "}
															{formatCount(
																data.totals.observations_by_type.tool,
															)}
														</td>
													</tr>
												</tbody>
											</table>
										</div>
									)}
								</CardContent>
							</Card>
						</section>

						{!hasUsage && (
							<Card>
								<CardContent className="p-5 pt-5">
									<h2 className="font-semibold">Connect telemetry</h2>
									<p className="mt-2 text-sm text-muted-foreground">
										There are no retained telemetry rows in this range. If this
										organization has not sent telemetry yet, configure an
										OpenTelemetry SDK with these values, then check
										Observability to confirm data arrives.
									</p>
									<pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs">
										<code>{otlpSetup(selectedProjectId)}</code>
									</pre>
									<div className="mt-4 flex flex-wrap gap-2">
										<Button
											type="button"
											size="sm"
											onClick={() => void copyOtlpSetup()}
										>
											<LuCopy className="mr-1.5 h-3.5 w-3.5" />
											Copy OTLP setup
										</Button>
										<a
											href="/reference"
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center text-sm text-link underline underline-offset-4"
										>
											API reference{" "}
											<LuExternalLink className="ml-1 h-3.5 w-3.5" />
										</a>
									</div>
									{copyState !== "idle" && (
										<p
											className="mt-2 text-xs text-muted-foreground"
											role="status"
										>
											{copyState === "copied"
												? "Copied."
												: "Clipboard access was unavailable."}
										</p>
									)}
								</CardContent>
							</Card>
						)}
					</>
				)
			)}
		</div>
	);
}
