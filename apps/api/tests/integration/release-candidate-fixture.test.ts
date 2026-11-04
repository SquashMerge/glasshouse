import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { migrate } from "../../src/db/migrate";

test("release candidate foreign organization fixture satisfies the migrated schema", async () => {
	if (!process.env.DATABASE_URL)
		throw new Error("Isolated PostgreSQL is required");
	const admin = new Pool({ connectionString: process.env.DATABASE_URL });
	const name = `candidate_fixture_${randomUUID().replaceAll("-", "")}`;
	let pool: Pool | undefined;
	try {
		await admin.query(`CREATE DATABASE ${name}`);
		const url = new URL(process.env.DATABASE_URL);
		url.pathname = `/${name}`;
		await migrate({ DATABASE_URL: url.toString() });
		pool = new Pool({ connectionString: url.toString() });
		const workflow = await readFile(
			resolve(
				import.meta.dir,
				"../../../../.github/workflows/release-candidate.yml",
			),
			"utf8",
		);
		const line = workflow
			.split("\n")
			.find((item) => item.includes("WITH o AS (INSERT INTO organizations"));
		if (!line) throw new Error("Foreign organization fixture is missing");
		const statement = line.match(/ -c "(WITH o AS .*?)"$/)?.[1];
		if (!statement)
			throw new Error("Foreign organization fixture is not parseable");
		await pool.query(statement);
		const result = await pool.query(
			"SELECT p.id, p.organization_id FROM projects p JOIN organizations o ON o.id = p.organization_id AND o.default_project_id = p.id WHERE p.id = $1",
			["d0000000-0000-4000-8000-000000000002"],
		);
		expect(result.rows).toEqual([
			{
				id: "d0000000-0000-4000-8000-000000000002",
				organization_id: "d0000000-0000-4000-8000-000000000001",
			},
		]);
	} finally {
		await pool?.end();
		await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		await admin.end();
	}
}, 60000);
