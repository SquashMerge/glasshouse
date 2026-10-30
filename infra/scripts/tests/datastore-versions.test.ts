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
	clickhouse: "clickhouse/clickhouse-server:26.10.3.7-alpine",
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

test("CI uses the production versions and retains an explicit historical restore fixture", () => {
	const ci = read(".github/workflows/ci.yml");
	expect(ci).toContain(`image: ${images.postgres}`);
	expect(ci).toContain(`image: ${images.clickhouse}`);
	expect(read("infra/scripts/test-db-migrations.sh")).toContain(
		images.postgres,
	);
	expect(ci).toContain(".github/compose.backup-restore-legacy.yaml");
	expect(ci).toContain("tests/integration/datastore-connectivity.test.ts");
	expect(ci).toContain(
		"Verify PostgreSQL 18 refuses an unmigrated root-level store",
	);
	expect(ci).toContain('BACKUP_RESTORE_APPLICATION_FIXTURE: "1"');
	const legacy = load(
		read(".github/compose.backup-restore-legacy.yaml"),
	) as Compose;
	expect(legacy.services.postgres.image).toBe("postgres:16.15-alpine");
	expect(legacy.services.clickhouse.image).toBe(
		"clickhouse/clickhouse-server:24.8.14.39-alpine",
	);
	expect(legacy.services.postgres.volumes).toContain(
		"postgres-data:/var/lib/postgresql/data",
	);
});

test("existing PostgreSQL physical volume identities are preserved for fail-closed upgrades", () => {
	expect(read("infra/compose.yaml")).toContain("name: astraea_astraea_pg_data");
	expect(read("infra/compose.deps.yaml")).toContain(
		"name: astraea-deps_astraea_pg_data",
	);
	expect(read("infra/compose.production.yaml")).toContain(
		"glasshouse_prod_pg_data:/var/lib/postgresql",
	);
	expect(read(".devcontainer/compose.yaml")).toContain(
		"postgres-data:/var/lib/postgresql",
	);
});
