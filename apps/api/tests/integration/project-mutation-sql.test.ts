import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const parameterTypes = [
	["uuid", "uuid", "text", "uuid"],
	["text", "text", "uuid", "uuid", "text", "uuid"],
	["uuid", "uuid", "text", "text", "text", "uuid"],
	["uuid", "text", "uuid", "text", "uuid"],
	["uuid", "text", "text", "text", "uuid"],
	["uuid", "text", "text", "uuid"],
];

test.skipIf(!databaseUrl)(
	"PostgreSQL parses every project-management mutation query",
	async () => {
		const source = await readFile(
			new URL("../../src/routes/projects.ts", import.meta.url),
			"utf8",
		);
		const statements = Array.from(
			source.matchAll(/"(WITH authz AS MATERIALIZED[^"]+)"/g),
			(match) => match[1],
		);
		expect(statements).toHaveLength(parameterTypes.length);

		const pool = new Pool({ connectionString: databaseUrl, max: 1 });
		const client = await pool.connect();
		try {
			for (const [index, sql] of statements.entries()) {
				const statementName = `project_mutation_sql_${index + 1}`;
				const types = parameterTypes[index];
				if (!types)
					throw new Error(`Missing parameter types for ${statementName}`);
				await client.query(
					`PREPARE ${statementName}(${types.join(", ")}) AS ${sql}`,
				);
				await client.query(`DEALLOCATE ${statementName}`);
			}
		} finally {
			client.release();
			await pool.end();
		}
	},
);
