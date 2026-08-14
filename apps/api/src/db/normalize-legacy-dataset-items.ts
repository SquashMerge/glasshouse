import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: url });
try {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const exists = await client.query(
			"SELECT to_regclass('public.dataset_items') AS table_name",
		);
		if (exists.rows[0]?.table_name) {
			await client.query(
				`CREATE TABLE IF NOT EXISTS dataset_item_input_quarantine (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT, dataset_id UUID NOT NULL, dataset_item_id UUID NOT NULL UNIQUE REFERENCES dataset_items(id) ON DELETE RESTRICT, original_input JSONB NOT NULL, reason TEXT NOT NULL CHECK (reason = 'input_not_object'), quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(), FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE RESTRICT)`,
			);
			await client.query(
				`INSERT INTO dataset_item_input_quarantine (project_id, dataset_id, dataset_item_id, original_input, reason) SELECT d.project_id, i.dataset_id, i.id, i.input, 'input_not_object' FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id WHERE jsonb_typeof(i.input) <> 'object' ON CONFLICT (dataset_item_id) DO NOTHING`,
			);
			await client.query(
				"UPDATE dataset_items SET input = jsonb_build_object('legacy_input', input) WHERE jsonb_typeof(input) <> 'object'",
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
} finally {
	await pool.end();
}
