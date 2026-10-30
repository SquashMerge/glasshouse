import { expect, test } from "bun:test";
import {
	DATASET_EXPORT_MAX_BYTES,
	DATASET_EXPORT_MAX_ITEMS,
	exportDataset,
} from "../../src/db/datasets";

const scope = {
	project_id: "11111111-1111-4111-8111-111111111111",
	slug: "test",
	representation: "version" as const,
	version: 1,
	authorization: {
		organization_id: "22222222-2222-4222-8222-222222222222",
		actor_id: "33333333-3333-4333-8333-333333333333",
		operation: "destructive" as const,
	},
};
function item(value = "benign") {
	return {
		item_key: value,
		input: { text: 'comma, quote" and\nnewline' },
		expected_output: null,
		metadata: {},
		external_id: value,
		source_trace_id: value,
		source_observation_id: value,
		feedback_score_id: value,
		capture_context: {},
		curated_by: value,
		reviewed_by: value,
		reviewed_at: null,
	};
}
function fixture(rows: Record<string, unknown>[]) {
	const queries: { sql: string; values?: unknown[] }[] = [];
	let fetched = 0;
	const client = {
		release() {},
		async query(sql: string, values?: unknown[]) {
			queries.push({ sql, values });
			if (sql.includes("p.status = ANY"))
				return { rows: [{ id: scope.project_id }] };
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (sql.includes("FROM datasets dataset"))
				return {
					rows: [
						{
							dataset_id: scope.project_id,
							slug: "test",
							source_id: scope.project_id,
							version: 1,
						},
					],
				};
			if (sql.startsWith("FETCH")) {
				const row = rows[fetched++];
				return {
					rows: row
						? [
								{
									export_item:
										Buffer.byteLength(JSON.stringify(row)) >
										DATASET_EXPORT_MAX_BYTES
											? null
											: row,
								},
							]
						: [],
				};
			}
			if (
				sql.startsWith("SELECT") &&
				sql.includes("FROM dataset_version_items")
			)
				return { rows };
			return { rows: [] };
		},
	};
	return {
		db: { connect: async () => client },
		queries,
		fetched: () => fetched,
	};
}
function parseCsv(body: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char === '"') {
			if (quoted && body[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = !quoted;
		} else if (!quoted && (char === "," || char === "\n")) {
			row.push(cell);
			cell = "";
			if (char === "\n") {
				rows.push(row);
				row = [];
			}
		} else cell += char;
	}
	return rows;
}

test("every CSV string-cell call site neutralizes formulas after whitespace/control prefixes", async () => {
	for (const prefix of [
		"=",
		"+",
		"-",
		"@",
		" \t=",
		"\r\n+",
		"\u0000@",
		"\u0085-",
		"\u2003=",
	]) {
		const value = `${prefix}SUM(1,2)`;
		const f = fixture([item(value)]);
		const rows = parseCsv(
			(await exportDataset(f.db as never, { ...scope, format: "csv" })).body,
		);
		for (const field of [
			"item_key",
			"external_id",
			"source_trace_id",
			"source_observation_id",
			"feedback_score_id",
			"curated_by",
			"reviewed_by",
		])
			expect(rows[1]?.[rows[0]!.indexOf(field)]).toBe(`'${value}`);
	}
});

test("CSV escaping preserves benign values, delimiters, quotes, and newlines; JSONL retains identities", async () => {
	for (const value of [
		"benign",
		"123",
		" a value",
		"a,b",
		'a"b',
		"a\nb",
		"'already literal",
	]) {
		const f = fixture([item(value)]);
		const rows = parseCsv(
			(await exportDataset(f.db as never, { ...scope, format: "csv" })).body,
		);
		expect(rows[1]?.[0]).toBe(value);
		expect(JSON.parse(rows[1]![1]!)).toEqual(item(value).input);
	}
	const f = fixture([item("=formula")]);
	expect(
		JSON.parse(
			(await exportDataset(f.db as never, { ...scope, format: "jsonl" })).body,
		).item_key,
	).toBe("=formula");
});

test("export retrieval is row- and byte-bounded before crossing the database boundary", async () => {
	const f = fixture([item()]);
	await exportDataset(f.db as never, { ...scope, format: "jsonl" });
	const query = f.queries.find(({ sql }) => sql.startsWith("DECLARE"));
	expect(query?.sql).toContain(`LIMIT ${DATASET_EXPORT_MAX_ITEMS + 1}`);
	expect(query?.sql).toContain("octet_length");
	expect(query?.sql).toContain("project_id = $1");
	expect(query?.values?.slice(0, 2)).toEqual([
		scope.project_id,
		scope.project_id,
	]);
	expect(f.queries.some(({ sql }) => sql.startsWith("FETCH FORWARD 1"))).toBe(
		true,
	);
});

test("item limit accepts the boundary and rejects the sentinel without an export audit", async () => {
	for (const count of [
		DATASET_EXPORT_MAX_ITEMS,
		DATASET_EXPORT_MAX_ITEMS + 1,
	]) {
		const f = fixture(Array.from({ length: count }, () => item()));
		const result = exportDataset(f.db as never, { ...scope, format: "jsonl" });
		if (count === DATASET_EXPORT_MAX_ITEMS)
			await expect(result).resolves.toBeDefined();
		else {
			await expect(result).rejects.toThrow("item limit");
			expect(f.queries.some(({ sql }) => sql.includes("'exported'"))).toBe(
				false,
			);
		}
	}
});

test("encoded byte limit accepts the exact boundary and stops on the first over-limit row", async () => {
	const base = item();
	const overhead = Buffer.byteLength(
		JSON.stringify({ ...base, external_id: "" }) + "\n",
	);
	for (const excess of [0, 1]) {
		const f = fixture([
			{
				...base,
				external_id: "x".repeat(DATASET_EXPORT_MAX_BYTES - overhead + excess),
			},
			...Array.from({ length: 20 }, () => item()),
		]);
		if (!excess) {
			const exact = fixture([
				{
					...base,
					external_id: "x".repeat(DATASET_EXPORT_MAX_BYTES - overhead),
				},
			]);
			expect(
				Buffer.byteLength(
					(
						await exportDataset(exact.db as never, {
							...scope,
							format: "jsonl",
						})
					).body,
				),
			).toBe(DATASET_EXPORT_MAX_BYTES);
		}
		await expect(
			exportDataset(f.db as never, { ...scope, format: "jsonl" }),
		).rejects.toThrow("byte limit");
		expect(f.fetched()).toBeLessThanOrEqual(2);
	}
});
