import { HealthBadge } from "../components/HealthBadge";

export function DashboardPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight">Astraea · MVP Foundation</h1>
        <p className="mt-2 text-lg text-muted-foreground">
          The platform exists. You can hit it in 60 seconds.
        </p>
      </header>

      <section className="space-y-4">
        <a
          href="/reference"
          target="_blank"
          rel="noreferrer"
          className="block rounded-lg border border-border bg-muted px-6 py-4 transition-colors hover:bg-muted/70"
        >
          <div className="text-sm font-medium text-muted-foreground">OpenAPI Reference</div>
          <div className="mt-1 text-base">/reference — Scalar UI for the typed OpenAPI contract</div>
        </a>

        <a
          href="/health"
          target="_blank"
          rel="noreferrer"
          className="block rounded-lg border border-border bg-muted px-6 py-4 transition-colors hover:bg-muted/70"
        >
          <div className="text-sm font-medium text-muted-foreground">Health Check</div>
          <div className="mt-1 text-base">/health — Postgres, ClickHouse, Valkey status</div>
        </a>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Stack status</h2>
        <div className="mt-3">
          <HealthBadge />
        </div>
      </section>
    </main>
  );
}