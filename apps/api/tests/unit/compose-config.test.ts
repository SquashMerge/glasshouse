import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Compose API database configuration", () => {
	it("provides a real migration URL and component variables without a placeholder password", () => {
		const compose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.yaml"),
			"utf8",
		);
		const apiEnvironment = compose.slice(
			compose.indexOf("  api:\n"),
			compose.indexOf("  web:\n"),
		);

		expect(apiEnvironment).toContain(
			"DATABASE_URL: postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-astraea}",
		);
		expect(apiEnvironment).not.toContain(":***@");
		expect(apiEnvironment).toContain("POSTGRES_HOST: postgres");
		expect(apiEnvironment).toContain(
			"POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in infra/.env}",
		);
	});
});
