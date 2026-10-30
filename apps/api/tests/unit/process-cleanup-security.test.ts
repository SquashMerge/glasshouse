import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeConfiguredLlm } from "../../src/lib/llm";
import { runGepaWorker } from "../../src/lib/gepa-worker";

const environment = { ...process.env };
afterEach(() => {
	process.env = { ...environment };
});
async function alive(pid: number) {
	try {
		return !(await readFile(`/proc/${pid}/stat`, "utf8"))
			.split(") ")[1]
			?.startsWith("Z");
	} catch {
		return false;
	}
}
async function waitForPids(path: string): Promise<number[]> {
	for (let i = 0; i < 100; i++) {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("process fixture did not start");
}
async function assertStopped(pids: number[]) {
	for (
		let i = 0;
		i < 100 && (await Promise.all(pids.map(alive))).some(Boolean);
		i++
	)
		await Bun.sleep(10);
	expect(await Promise.all(pids.map(alive))).toEqual(pids.map(() => false));
}
function cleanup(pids: number[]) {
	for (const pid of pids) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

for (const mode of ["stdout", "stderr", "abort", "timeout"] as const) {
	test(`development CLI ${mode} kills the owned process tree before settling`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "glasshouse-process-test-"));
		const path = join(dir, "pids.json");
		let pids: number[] = [];
		const controller = new AbortController();
		const script = `const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdout: 'ignore', stderr: 'ignore'}); await Bun.write(${JSON.stringify(path)}, JSON.stringify([process.pid, child.pid])); ${mode === "stdout" || mode === "stderr" ? `process.${mode}.write('x'.repeat(128 * 1024));` : ""} setInterval(() => {}, 1000);`;
		process.env.GLASSHOUSE_DEV_LLM_COMMAND = JSON.stringify([
			process.execPath,
			"-e",
			script,
		]);
		process.env.GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS =
			mode === "timeout" ? "0.2" : "30";
		try {
			const result = invokeConfiguredLlm(
				{},
				{ provider: "codex_cli", model: "test" },
				controller.signal,
			);
			const settled = result.then(
				() => "resolved",
				() => "rejected",
			);
			pids = await waitForPids(path);
			if (mode === "abort") controller.abort();
			expect(
				await Promise.race([settled, Bun.sleep(2000).then(() => "pending")]),
			).toBe("rejected");
			await assertStopped(pids);
		} finally {
			controller.abort();
			cleanup(pids);
			await rm(dir, { recursive: true, force: true });
		}
	}, 6000);
}

for (const mode of ["abort", "worker-death"] as const) {
	test(`GEPA ${mode} kills Python's CLI and descendant at the real worker owner boundary`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "glasshouse-gepa-tree-"));
		const path = join(dir, "pids.json");
		const shim = join(dir, "python-shim");
		// Exercise run_dev_cli without GEPA, credentials, or a provider. The API still
		// owns and cancels the real Python subprocess via runGepaWorker.
		const root = new URL("../../../../", import.meta.url).pathname;
		const script = `#!/usr/bin/python3\nimport json, os, sys\nsys.path.insert(0, ${JSON.stringify(root)})\nfrom worker.dev_cli_llm import run_dev_cli\nrun_dev_cli('test', 'local')\n`;
		let pids: number[] = [];
		const controller = new AbortController();
		const { chmod, writeFile } = await import("node:fs/promises");
		await writeFile(shim, script);
		await chmod(shim, 0o700);
		process.env.GEPA_PYTHON = shim;
		process.env.GEPA_WORKER_MODE = "cli";
		process.env.GLASSHOUSE_DEV_LLM_COMMAND = JSON.stringify([
			"/usr/bin/python3",
			"-c",
			`import json,os,pathlib,subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); pathlib.Path(${JSON.stringify(path)}).write_text(json.dumps([os.getppid(),os.getpid(),child.pid])); time.sleep(30)`,
		]);
		try {
			const result = runGepaWorker(
				{ budget: { max_metric_calls: 2 } } as never,
				controller.signal,
			);
			const settled = result.then(
				() => "resolved",
				() => "rejected",
			);
			pids = await waitForPids(path);
			if (mode === "worker-death") process.kill(pids[0]!, "SIGKILL");
			else controller.abort();
			expect(
				await Promise.race([settled, Bun.sleep(2000).then(() => "pending")]),
			).toBe("rejected");
			await assertStopped(pids);
		} finally {
			controller.abort();
			cleanup(pids);
			await rm(dir, { recursive: true, force: true });
		}
	}, 6000);
}
