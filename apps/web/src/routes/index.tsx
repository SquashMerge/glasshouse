import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LuCopy, LuExternalLink } from "react-icons/lu";
import { HealthBadge } from "../components/HealthBadge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useProjectSelection } from "../components/ProjectProvider";
import { copyText } from "../lib/clipboard";
import { listTraces } from "../lib/api";

const OTLP_SETUP = `export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/v1/otel
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Basic <base64(username:password)>'
export OTEL_SERVICE_NAME=my-agent`;

export function DashboardPage() {
	const { selectedProjectId } = useProjectSelection();
	const [copyState, setCopyState] = React.useState<
		"idle" | "copied" | "failed"
	>("idle");
	const recent = useQuery({
		queryKey: ["dashboard", "recent-traces", selectedProjectId],
		queryFn: () => listTraces({ project_id: selectedProjectId!, limit: 5 }),
		enabled: Boolean(selectedProjectId),
	});
	const failures = useQuery({
		queryKey: ["dashboard", "failed-traces", selectedProjectId],
		queryFn: () =>
			listTraces({ project_id: selectedProjectId!, status: "error", limit: 1 }),
		enabled: Boolean(selectedProjectId),
	});

	async function copyOtlpSetup() {
		const result = await copyText(OTLP_SETUP);
		setCopyState(result.ok ? "copied" : "failed");
	}

	const failedCount = failures.data?.total ?? 0;
	const recentTraces = recent.data?.items ?? [];

	return (
		<main className="space-y-8 py-10 sm:py-12">
			<header>
				<h1 className="text-4xl font-semibold tracking-tight">
					Operations overview
				</h1>
				<p className="mt-2 text-muted-foreground">
					See whether telemetry is flowing, investigate failures, and pick up
					where your team left off.
				</p>
			</header>

			<section
				className="grid gap-6 md:grid-cols-3"
				aria-label="Telemetry summary"
			>
				<Card className="transition-colors hover:bg-muted/70">
					<Link
						to="/observability"
						className="block h-full p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<p className="text-sm font-medium text-muted-foreground">
							Recent traces
						</p>
						<p className="mt-2 text-2xl font-semibold">
							{recent.isPending ? "Loading…" : (recent.data?.total ?? 0)}
						</p>
						<p className="mt-1 text-sm text-muted-foreground">
							Open observability
						</p>
					</Link>
				</Card>
				<Card className="transition-colors hover:bg-muted/70">
					<Link
						to="/observability"
						search={{ tab: "traces", "traces.status": "error" }}
						className="block h-full p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<p className="text-sm font-medium text-muted-foreground">
							Failures
						</p>
						<p className="mt-2 text-2xl font-semibold text-destructive">
							{failures.isPending ? "Loading…" : `${failedCount} failed traces`}
						</p>
						<p className="mt-1 text-sm text-muted-foreground">
							Investigate errors
						</p>
					</Link>
				</Card>
				<Card>
					<CardContent className="p-5 pt-5">
						<p className="text-sm font-medium text-muted-foreground">
							Service health
						</p>
						<div className="mt-3">
							<HealthBadge />
						</div>
					</CardContent>
				</Card>
			</section>

			<section
				className="grid gap-6 lg:grid-cols-2"
				aria-label="Dashboard actions"
			>
				<Card>
					<CardContent className="p-5 pt-5">
						<div className="flex items-center justify-between gap-3">
							<h2 className="font-semibold">Recent traces</h2>
							<Link
								to="/observability"
								className="text-sm text-primary hover:underline"
							>
								View all
							</Link>
						</div>
						{recent.isError ? (
							<p className="mt-4 text-sm text-destructive">
								Could not load recent traces.
							</p>
						) : recentTraces.length === 0 && !recent.isPending ? (
							<p className="mt-4 text-sm text-muted-foreground">
								No traces yet.
							</p>
						) : (
							<ul
								className="mt-3 divide-y divide-border"
								aria-busy={recent.isPending}
							>
								{recentTraces.map((trace) => (
									<li key={trace.trace_id} className="py-3 text-sm">
										<Link
											to="/observability/traces/$id"
											params={{ id: trace.trace_id }}
											className="font-medium hover:underline"
										>
											{trace.name}
										</Link>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardContent className="p-5 pt-5">
						<h2 className="font-semibold">Send your first trace</h2>
						<p className="mt-2 text-sm text-muted-foreground">
							Configure any OpenTelemetry SDK with these values, then open
							Observability to verify the trace arrives.
						</p>
						<pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs">
							<code>{OTLP_SETUP}</code>
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
								className="inline-flex items-center text-sm text-primary hover:underline"
							>
								API reference <LuExternalLink className="ml-1 h-3.5 w-3.5" />
							</a>
						</div>
						{copyState !== "idle" && (
							<p className="mt-2 text-xs text-muted-foreground" role="status">
								{copyState === "copied"
									? "Copied."
									: "Clipboard access was unavailable."}
							</p>
						)}
					</CardContent>
				</Card>
			</section>
		</main>
	);
}
