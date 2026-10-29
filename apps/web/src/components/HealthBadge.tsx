import { useQuery } from "@tanstack/react-query";

type HealthResponse = {
	status: "ok" | "degraded";
	checks: {
		postgres: "up" | "down";
		clickhouse: "up" | "down";
		valkey: "up" | "down";
	};
};

async function fetchHealth(): Promise<HealthResponse> {
	const res = await fetch("/health", {
		headers: { accept: "application/json" },
	});
	if (!res.ok && res.status !== 503)
		throw new Error(`health responded ${res.status}`);
	const data = (await res.json()) as Partial<HealthResponse> | null;
	if (
		!data ||
		(data.status !== "ok" && data.status !== "degraded") ||
		!data.checks ||
		!["postgres", "clickhouse", "valkey"].every((key) => {
			const state = data.checks?.[key as keyof HealthResponse["checks"]];
			return state === "up" || state === "down";
		})
	)
		throw new Error("Invalid health response");
	return data as HealthResponse;
}

function Pill({
	label,
	state,
}: {
	label: string;
	state: "up" | "down" | "loading" | "unknown";
}) {
	const color =
		state === "loading"
			? "bg-muted text-muted-foreground"
			: state === "up"
				? "bg-success/20 text-success"
				: state === "down"
					? "bg-destructive/20 text-destructive"
					: "bg-muted text-muted-foreground";
	return (
		<span
			className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${color}`}
		>
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
				<Pill label="Postgres" state="loading" />
				<Pill label="ClickHouse" state="loading" />
				<Pill label="Valkey" state="loading" />
			</div>
		);
	}

	if (isError || !data) {
		return (
			<div className="flex flex-wrap gap-2">
				<Pill label="Postgres" state="unknown" />
				<Pill label="ClickHouse" state="unknown" />
				<Pill label="Valkey" state="unknown" />
			</div>
		);
	}

	return (
		<div className="flex flex-wrap gap-2">
			<Pill label="Postgres" state={data.checks.postgres} />
			<Pill label="ClickHouse" state={data.checks.clickhouse} />
			<Pill label="Valkey" state={data.checks.valkey} />
		</div>
	);
}
