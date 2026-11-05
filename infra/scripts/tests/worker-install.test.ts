import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

it("installs native Alpine Node and full ICU for Vitest/jsdom instead of relying on Bun's node shim", () => {
	const dockerfile = readFileSync(
		new URL("../../../.devcontainer/Dockerfile", import.meta.url),
		"utf8",
	);
	const packages =
		dockerfile.match(/RUN apk add --no-cache ([^\n]+)/)?.[1]?.split(/\s+/) ??
		[];
	expect(packages).toContain("nodejs");
	expect(packages).toContain("icu-data-full");
	expect(dockerfile).toContain("RUN node -e");
});

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
