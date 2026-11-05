import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production Bun aborts real ClickHouse inserts over HTTP and gRPC", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"test",
			new URL("../fixtures/otlp-clickhouse-bun.test.ts", import.meta.url)
				.pathname,
		],
		{ stdout: "pipe", stderr: "pipe", timeout: 25_000 },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, `${stdout}\n${stderr}`).toBe(0);
	expect(stderr).toContain("13 pass");
}, 30_000);

test("real ClickHouse timeout responses under native Node", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "glasshouse-clickhouse-timeout-"),
	);
	try {
		// Bun 1.3.14 does not fire this client's socket timeout; use native Node
		// to exercise the pinned dependency's actual error, not a fabricated one.
		const output = join(directory, "timeout.cjs");
		const build = Bun.spawn(
			[
				process.execPath,
				"build",
				new URL("../fixtures/otlp-clickhouse-timeout.ts", import.meta.url)
					.pathname,
				"--target=node",
				"--format=cjs",
				`--outfile=${output}`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const buildError = await new Response(build.stderr).text();
		expect(await build.exited, buildError).toBe(0);
		const child = Bun.spawn(
			[
				"sh",
				"-c",
				'ulimit -c 0; exec node --test-reporter=tap "$1"',
				"sh",
				output,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NODE_OPTIONS: "" },
				timeout: 10_000,
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, `${stdout}\n${stderr}`).toBe(0);
		expect(stdout).toContain("# pass 7");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
