import { describe, expect, it } from "bun:test";
import {
	decodeTraceCursor,
	encodeTraceCursor,
	InvalidTraceCursorError,
} from "../../src/db/trace-cursor";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_A = "0123456789abcdef0123456789abcdef";
const TRACE_B = "fedcba9876543210fedcba9876543210";

describe("trace detail cursors", () => {
	it("cannot be replayed against another trace in the same project", () => {
		const cursor = encodeTraceCursor(
			"trace-observations",
			PROJECT_ID,
			{ start_time: "2026-09-13 00:00:00.000", id: "observation-a" },
			TRACE_A,
		);

		expect(() =>
			decodeTraceCursor(cursor, "trace-observations", PROJECT_ID, TRACE_B),
		).toThrow(InvalidTraceCursorError);
	});
});
