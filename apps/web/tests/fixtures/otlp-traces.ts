export function hex(bytes: number): string {
	const characters = "0123456789abcdef";
	let value = "";
	for (let index = 0; index < bytes * 2; index += 1)
		value += characters[Math.floor(Math.random() * characters.length)];
	return value;
}

export function buildFeedbackTracePayload({
	projectId,
	traceId,
	spanId,
	name,
	input,
	output,
}: {
	projectId: string;
	traceId: string;
	spanId: string;
	name: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
}) {
	const timestamp = BigInt(Date.now()) * 1_000_000n;
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "first-pass-e2e" } },
						{
							key: "glasshouse.project.id",
							value: { stringValue: projectId },
						},
					],
				},
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId,
								name,
								kind: 1,
								startTimeUnixNano: timestamp.toString(),
								endTimeUnixNano: (timestamp + 1_000_000n).toString(),
								status: { code: 1 },
								attributes: [
									{
										key: "gen_ai.request.model",
										value: { stringValue: "e2e-model" },
									},
									{
										key: "gen_ai.prompt.0.content",
										value: { stringValue: JSON.stringify(input) },
									},
									{
										key: "gen_ai.completion.0.content",
										value: { stringValue: JSON.stringify(output) },
									},
								],
							},
						],
					},
				],
			},
		],
	};
}

export function buildTracePayload(
	projectId: string,
	traceId: string,
	rootSpanId: string,
	spanCount: number,
	traceName: string,
	startIndex = 0,
) {
	const timestamp = BigInt(Date.now()) * 1_000_000n;
	const spans = [];
	for (let i = 0; i < spanCount; i += 1) {
		const index = startIndex + i;
		const start = timestamp + BigInt(index * 50) * 1_000_000n;
		const durationMs = index === 0 ? (spanCount - 1) * 50 + 100 : 100;
		spans.push({
			traceId,
			spanId: index === 0 ? rootSpanId : hex(8),
			...(index === 0 ? {} : { parentSpanId: rootSpanId }),
			name: index === 0 ? traceName : `${traceName}.child.${index}`,
			kind: 1,
			startTimeUnixNano: start.toString(),
			endTimeUnixNano: (start + BigInt(durationMs) * 1_000_000n).toString(),
			status: { code: 1 },
			attributes: [],
		});
	}
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "glasshouse-e2e" } },
						{
							key: "glasshouse.project.id",
							value: { stringValue: projectId },
						},
					],
				},
				scopeSpans: [
					{
						scope: { name: "glasshouse-e2e", version: "1.0.0" },
						spans,
					},
				],
			},
		],
	};
}
