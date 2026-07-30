import { HealthBadge } from "../components/HealthBadge";
import { Link } from "@tanstack/react-router";

export function DashboardPage() {
	return (
		<main className="py-16">
			<header className="mb-12">
				<h1 className="text-4xl font-semibold tracking-tight">
					Operations overview
				</h1>
				<p className="mt-2 text-lg text-muted-foreground">
					Inspect recent agent activity, investigate failures, and verify
					telemetry is flowing.
				</p>
			</header>

			<section className="grid gap-4 sm:grid-cols-2">
				<Link
					to="/observability"
					className="block rounded-lg border border-border bg-card px-6 py-4 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<div className="text-sm font-medium text-muted-foreground">
						Observability
					</div>
					<div className="mt-1 text-base">
						View traces, errors, and live observations
					</div>
				</Link>
				<div className="rounded-lg border border-border bg-card px-6 py-4">
					<div className="text-sm font-medium text-muted-foreground">
						First trace
					</div>
					<div className="mt-1 text-base">
						Send OTLP to <code>/v1/otel/v1/traces</code>
					</div>
					<p className="mt-2 text-sm text-muted-foreground">
						Use the credentials from <code>infra/.env</code>; new telemetry
						appears in Observability.
					</p>
				</div>
			</section>

			<section className="mt-4 space-y-4">
				<a
					href="/reference"
					target="_blank"
					rel="noreferrer"
					className="block rounded-lg border border-border bg-muted px-6 py-4 transition-colors hover:bg-muted/70"
				>
					<div className="text-sm font-medium text-muted-foreground">
						OpenAPI Reference
					</div>
					<div className="mt-1 text-base">
						/reference — Scalar UI for the typed OpenAPI contract
					</div>
				</a>

				<a
					href="/health"
					target="_blank"
					rel="noreferrer"
					className="block rounded-lg border border-border bg-muted px-6 py-4 transition-colors hover:bg-muted/70"
				>
					<div className="text-sm font-medium text-muted-foreground">
						Health Check
					</div>
					<div className="mt-1 text-base">
						/health — Postgres, ClickHouse, Valkey status
					</div>
				</a>
			</section>

			<section className="mt-12">
				<h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
					Stack status
				</h2>
				<div className="mt-3">
					<HealthBadge />
				</div>
			</section>
		</main>
	);
}
