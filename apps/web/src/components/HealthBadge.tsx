import { useQuery } from "@tanstack/react-query";

type HealthResponse = {
  status: "ok" | "degraded";
  checks: {
    postgres: "up" | "down";
    clickhouse: "up" | "down";
    redis: "up" | "down";
  };
};

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/health", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`health responded ${res.status}`);
  return (await res.json()) as HealthResponse;
}

function Pill({ label, state }: { label: string; state: "up" | "down" | "loading" }) {
  const color =
    state === "loading" ? "bg-muted text-muted-foreground" :
    state === "up" ? "bg-success/20 text-success" :
    "bg-destructive/20 text-destructive";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${color}`}>
      <span className="size-2 rounded-full bg-current" />
      {label}: {state}
    </span>
  );
}

export function HealthBadge() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-2">
        <Pill label="postgres" state="loading" />
        <Pill label="clickhouse" state="loading" />
        <Pill label="redis" state="loading" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-wrap gap-2">
        <Pill label="postgres" state="down" />
        <Pill label="clickhouse" state="down" />
        <Pill label="redis" state="down" />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Pill label="postgres" state={data.checks.postgres} />
      <Pill label="clickhouse" state={data.checks.clickhouse} />
      <Pill label="redis" state={data.checks.redis} />
    </div>
  );
}