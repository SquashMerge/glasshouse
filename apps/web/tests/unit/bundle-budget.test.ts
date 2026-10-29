import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("emits lazy page chunks and keeps every minified JS chunk below 500 kB", () => {
	const build = spawnSync("bun", ["run", "build", "--manifest"], {
		cwd: process.cwd(),
		// A devcontainer's inherited mode must not change production artifacts.
		env: { ...process.env, NODE_ENV: "development", NO_COLOR: "1" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 25_000,
	});
	const output = `${build.stdout ?? ""}\n${build.stderr ?? ""}`;
	expect(build.error, output).toBeUndefined();
	expect(build.signal, output).toBeNull();
	expect(build.status, output).toBe(0);
	const sizes = readdirSync("dist/assets")
		.filter((file) => file.endsWith(".js"))
		.map((file) => ({
			file,
			bytes: readFileSync(`dist/assets/${file}`).length,
		}));
	expect(sizes.filter((chunk) => chunk.bytes > 500_000)).toEqual([]);
	expect(output).not.toContain("Some chunks are larger than");
	const manifest = JSON.parse(
		readFileSync("dist/.vite/manifest.json", "utf8"),
	) as Record<string, { isDynamicEntry?: boolean }>;
	const lazyPages = Object.entries(manifest)
		.filter(([, chunk]) => chunk.isDynamicEntry)
		.map(([path]) => path.replace("src/routes/", ""));
	expect(lazyPages).toEqual(
		expect.arrayContaining([
			"login.tsx",
			"setup.tsx",
			"enroll.tsx",
			"index.tsx",
			"observability.tsx",
			"observability/traces/$id.tsx",
			"prompts.tsx",
			"prompts-new.tsx",
			"prompts-detail.tsx",
			"prompts-edit.tsx",
			"datasets.tsx",
			"evaluations.tsx",
			"feedback.tsx",
			"projects.tsx",
			"governance.tsx",
			"admin-access.tsx",
			"password-change.tsx",
			"otlp-credentials.tsx",
		]),
	);
}, 30_000);
