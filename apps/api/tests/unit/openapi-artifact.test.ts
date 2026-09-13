import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";

const root = join(import.meta.dir, "../../../..");
const checkScript = join(root, "infra/codegen/check-snapshot.sh");

describe("OpenAPI canonical artifact", () => {
	it("fails before generation when the canonical artifact is absent", () => {
		const directory = mkdtempSync(join(tmpdir(), "astraea-openapi-"));
		const canonicalPath = join(directory, "missing.yaml");
		try {
			const result = spawnSync("bash", [checkScript], {
				cwd: root,
				env: { ...process.env, OPENAPI_CANONICAL_PATH: canonicalPath },
				encoding: "utf8",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				`OpenAPI canonical artifact is missing: ${canonicalPath}`,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
