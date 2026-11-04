const protobufContentTypes = new Set([
	"application/x-protobuf",
	"application/protobuf",
]);

function contentType(
	request: Request,
): "application/json" | "application/x-protobuf" {
	return protobufContentTypes.has(
		request.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() ?? "",
	)
		? "application/x-protobuf"
		: "application/json";
}

function varint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = value >>> 0;
	do {
		const byte = remaining & 0x7f;
		remaining >>>= 7;
		bytes.push(remaining ? byte | 0x80 : byte);
	} while (remaining);
	return bytes;
}

function lengthDelimited(field: number, value: Uint8Array): Uint8Array {
	return new Uint8Array([(field << 3) | 2, ...varint(value.length), ...value]);
}

function googleRpcStatus(message: string): Uint8Array {
	return lengthDelimited(2, new TextEncoder().encode(message));
}

export function otlpErrorResponse(request: Request, status: number): Response {
	const message = errorMessage(status);
	const type = contentType(request);
	return new Response(
		type === "application/json"
			? JSON.stringify({ message })
			: googleRpcStatus(message),
		{
			status,
			headers: {
				"cache-control": "no-store",
				"content-type": type,
			},
		},
	);
}

export function otlpSuccessResponse(
	request: Request,
	rejectedSpans = 0,
): Response {
	const type = contentType(request);
	if (!rejectedSpans)
		return new Response(type === "application/json" ? "{}" : new Uint8Array(), {
			status: 200,
			headers: { "content-type": type },
		});

	const message = "Spans with events or links are not supported";
	if (type === "application/json")
		return new Response(
			JSON.stringify({
				partialSuccess: {
					rejectedSpans: String(rejectedSpans),
					errorMessage: message,
				},
			}),
			{ status: 200, headers: { "content-type": type } },
		);

	const partial = new Uint8Array([
		8,
		...varint(rejectedSpans),
		...lengthDelimited(2, new TextEncoder().encode(message)),
	]);
	return new Response(lengthDelimited(1, partial), {
		status: 200,
		headers: { "content-type": type },
	});
}

function errorMessage(status: number): string {
	if (status === 400) return "Invalid trace export request";
	if (status === 401) return "Authentication required";
	if (status === 403 || status === 404) return "Trace export rejected";
	if (status === 413) return "Trace export exceeds the request limit";
	if (status === 415) return "Unsupported trace export media type";
	if (status === 429) return "Trace export temporarily unavailable";
	return "Trace export failed";
}
