import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

it("installs the committed hash-verified worker lock in the devcontainer", () => {
	const configuration = JSON.parse(
		readFileSync(
			new URL("../../../.devcontainer/devcontainer.json", import.meta.url),
			"utf8",
		),
	);
	expect(configuration.postCreateCommand).toContain(
		".venv-gepa/bin/pip install --no-cache-dir --require-hashes -r worker/requirements.lock",
	);
	expect(configuration.postCreateCommand).not.toContain("requirements.txt");
});
