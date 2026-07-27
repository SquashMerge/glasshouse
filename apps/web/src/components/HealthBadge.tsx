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
	if (!res.ok) throw new Error(`health responded ${res.status}`);
	return (await res.json()) as HealthResponse;
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
				<Pill label="postgres" state="loading" />
				<Pill label="clickhouse" state="loading" />
				<Pill label="valkey" state="loading" />
			</div>
		);
	}

	if (isError || !data) {
		return (
			<div className="flex flex-wrap gap-2">
				<Pill label="postgres" state="unknown" />
				<Pill label="clickhouse" state="unknown" />
				<Pill label="valkey" state="unknown" />
			</div>
		);
	}

	return (
		<div className="flex flex-wrap gap-2">
			<Pill label="postgres" state={data.checks.postgres} />
			<Pill label="clickhouse" state={data.checks.clickhouse} />
			<Pill label="valkey" state={data.checks.valkey} />
		</div>
	);
}
