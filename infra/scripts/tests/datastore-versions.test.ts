import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
type Service = { image: string; volumes?: string[] };
type Compose = { services: Record<string, Service> };
const images = {
	postgres: "postgres:18.6-alpine",
	clickhouse: "clickhouse/clickhouse-server:26.10.2.103-alpine",
	valkey: "valkey/valkey:9.1.3-alpine",
};

for (const path of [
	"infra/compose.yaml",
	"infra/compose.deps.yaml",
	"infra/compose.production.yaml",
	".devcontainer/compose.yaml",
	".github/compose.backup-restore.yaml",
]) {
	test(`${path} pins current datastores and persists the PostgreSQL 18 parent directory`, () => {
		const { services } = load(read(path)) as Compose;
		for (const [name, image] of Object.entries(images)) {
			if (name === "valkey" && !services[name]) continue;
			expect(services[name].image).toBe(image);
		}
		expect(
			services.postgres.volumes?.some((mount) =>
				mount.endsWith(":/var/lib/postgresql"),
			),
		).toBe(true);
		expect(
			services.postgres.volumes?.some((mount) =>
				mount.endsWith(":/var/lib/postgresql/data"),
			),
		).toBe(false);
	});
}

test("CI restores current-version backups and checks production client connectivity", () => {
	const ci = read(".github/workflows/ci.yml");
	expect(ci).toContain(`image: ${images.postgres}`);
	expect(ci).toContain(`image: ${images.clickhouse}`);
	expect(read("infra/scripts/test-db-migrations.sh")).toContain(
		images.postgres,
	);
	const { jobs } = load(ci) as {
		jobs: Record<string, { strategy?: unknown; env: Record<string, string> }>;
	};
	const backup = jobs["backup-restore-integration"];
	expect(backup.strategy).toBeUndefined();
	expect(backup.env.BACKUP_SOURCE_COMPOSE_FILE).toBe(
		".github/compose.backup-restore.yaml",
	);
	expect(backup.env.RESTORE_TARGET_COMPOSE_FILE).toBe(
		"${{ github.workspace }}/.github/compose.backup-restore.yaml",
	);
	expect(backup.env.BACKUP_RESTORE_APPLICATION_FIXTURE).toBe("1");
	expect(ci).toContain("tests/integration/datastore-connectivity.test.ts");
	expect(ci).toContain("GLASSHOUSE_VERIFY_DATASTORE_VERSIONS=1");
});
