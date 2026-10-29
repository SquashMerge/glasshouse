import { expect, test } from "bun:test";
import { Pool } from "pg";
import { DATASET_EXPORT_MAX_BYTES, exportDataset } from "../../src/db/datasets";

test("PostgreSQL export cursor bounds legacy rows, count, and tenant selection before materialization", async () => {
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
	const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	const client = await pool.connect();
	const project = "11111111-1111-4111-8111-111111111111";
	const other = "22222222-2222-4222-8222-222222222222";
	const source = "33333333-3333-4333-8333-333333333333";
	const scope = {
		project_id: project,
		slug: "test",
		format: "jsonl" as const,
		representation: "version" as const,
		version: 1,
		authorization: {
			organization_id: other,
			actor_id: other,
			operation: "destructive" as const,
		},
	};
	let fetched = 0;
	const transactional = {
		connect: async () => ({
			release() {},
			async query(sql: string, values?: unknown[]) {
				if (
					["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
					/^(DECLARE|FETCH|CLOSE)/.test(sql)
				) {
					const result = await client.query(sql, values);
					if (sql.startsWith("FETCH")) fetched++;
					return result;
				}
				if (sql.includes("FROM datasets dataset"))
					return {
						rows: [
							{
								dataset_id: source,
								source_id: source,
								slug: "test",
								version: 1,
							},
						],
					};
				if (sql.includes("p.status = ANY")) return { rows: [{ id: project }] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				return { rows: [] };
			},
		}),
	};
	try {
		await client.query(
			`CREATE TEMP TABLE dataset_version_items (project_id uuid, dataset_version_id uuid, position int, item_key text, input jsonb DEFAULT '{}', expected_output jsonb, metadata jsonb DEFAULT '{}', external_id text, source_trace_id text, source_observation_id text, feedback_score_id text, capture_context jsonb DEFAULT '{}', curated_by text, reviewed_by text, reviewed_at timestamptz)`,
		);
		await client.query(
			"INSERT INTO dataset_version_items (project_id,dataset_version_id,position,item_key) VALUES ($1,$2,0,'allowed'),($3,$2,0,'foreign')",
			[project, source, other],
		);
		const result = await exportDataset(transactional as never, scope);
		expect(JSON.parse(result.body).item_key).toBe("allowed");
		expect(result.body).not.toContain("foreign");
		await client.query(
			"UPDATE dataset_version_items SET input = jsonb_build_object('legacy', repeat('x', $1::int)) WHERE project_id = $2",
			[DATASET_EXPORT_MAX_BYTES * 2 + 1, project],
		);
		fetched = 0;
		await expect(exportDataset(transactional as never, scope)).rejects.toThrow(
			"byte limit",
		);
		expect(fetched).toBe(1);
		await client.query("TRUNCATE dataset_version_items");
		await client.query(
			"INSERT INTO dataset_version_items (project_id,dataset_version_id,position,item_key) SELECT $1,$2,i,i::text FROM generate_series(1,501) i",
			[project, source],
		);
		fetched = 0;
		await expect(exportDataset(transactional as never, scope)).rejects.toThrow(
			"item limit",
		);
		expect(fetched).toBe(501);
	} finally {
		await client.query("ROLLBACK");
		client.release();
		await pool.end();
	}
}, 15000);
