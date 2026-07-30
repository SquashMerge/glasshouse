import type { TimeRange } from "../components/TimeRangePicker";

export type ObservabilitySearchState = {
	filters: Record<string, string>;
	timeRange: TimeRange;
};

function defaultFilters(filterKeys: readonly string[]): Record<string, string> {
	return Object.fromEntries(filterKeys.map((key) => [key, ""]));
}

export function parseObservabilitySearch(
	search: string,
	prefix: string,
	filterKeys: readonly string[],
): ObservabilitySearchState {
	const params = new URLSearchParams(search);
	const filters = defaultFilters(filterKeys);
	for (const key of filterKeys)
		filters[key] = params.get(`${prefix}.${key}`) ?? "";

	const range = params.get(`${prefix}.range`);
	if (range === "last") {
		const minutes = Number(params.get(`${prefix}.minutes`));
		if (Number.isFinite(minutes) && minutes > 0)
			return { filters, timeRange: { kind: "last", minutes } };
	}
	if (range === "custom") {
		return {
			filters,
			timeRange: {
				kind: "custom",
				from: params.get(`${prefix}.from`) ?? "",
				to: params.get(`${prefix}.to`) ?? "",
			},
		};
	}
	return { filters, timeRange: { kind: "all" } };
}

export function serializeObservabilitySearch(
	search: string,
	prefix: string,
	state: ObservabilitySearchState,
): string {
	const params = new URLSearchParams(search);
	for (const key of Object.keys(state.filters))
		params.delete(`${prefix}.${key}`);
	for (const key of ["range", "minutes", "from", "to"])
		params.delete(`${prefix}.${key}`);

	for (const [key, value] of Object.entries(state.filters)) {
		if (value) params.set(`${prefix}.${key}`, value);
	}
	if (state.timeRange.kind === "last") {
		params.set(`${prefix}.range`, "last");
		params.set(`${prefix}.minutes`, String(state.timeRange.minutes));
	}
	if (state.timeRange.kind === "custom") {
		params.set(`${prefix}.range`, "custom");
		params.set(`${prefix}.from`, state.timeRange.from);
		params.set(`${prefix}.to`, state.timeRange.to);
	}
	const output = params.toString();
	return output ? `?${output}` : "";
}
