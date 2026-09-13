export type TraceCursorKind = "traces" | "observations" | "trace-observations";

export interface TraceCursor {
	start_time: string;
	id: string;
}

interface StoredTraceCursor extends TraceCursor {
	v: 1;
	kind: TraceCursorKind;
	project_id: string;
}

export class InvalidTraceCursorError extends Error {
	constructor() {
		super("Invalid or mismatched trace cursor");
	}
}

export function encodeTraceCursor(
	kind: TraceCursorKind,
	projectId: string,
	cursor: TraceCursor,
): string {
	return Buffer.from(
		JSON.stringify({ v: 1, kind, project_id: projectId, ...cursor }),
	).toString("base64url");
}

export function decodeTraceCursor(
	encoded: string | undefined,
	kind: TraceCursorKind,
	projectId: string,
): TraceCursor | undefined {
	if (!encoded) return undefined;
	try {
		const value = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as Partial<StoredTraceCursor>;
		if (
			value.v !== 1 ||
			value.kind !== kind ||
			value.project_id !== projectId ||
			typeof value.start_time !== "string" ||
			value.start_time.length === 0 ||
			typeof value.id !== "string" ||
			value.id.length === 0
		)
			throw new InvalidTraceCursorError();
		return { start_time: value.start_time, id: value.id };
	} catch {
		throw new InvalidTraceCursorError();
	}
}
