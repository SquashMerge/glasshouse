import { expect, it } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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

it.each([
	["22.12.0", false],
	["22.22.1", false],
	["22.22.2", true],
	["22.23.4", true],
	["23.0.0", false],
	["24.14.9", false],
	["24.15.0", true],
	["25.0.0", false],
	["26.0.0", true],
	["27.0.0", true],
])(
	"checks jsdom's supported native Node range for %s",
	(version, supported) => {
		const dockerfile = readFileSync(
			new URL("../../../.devcontainer/Dockerfile", import.meta.url),
			"utf8",
		);
		const command = dockerfile.match(/RUN node -e '([\s\S]*?)'/)?.[1];
		expect(command).toBeDefined();
		const check = () =>
			runInNewContext(command?.replace(/\\\n/g, "") ?? "", {
				require: () => assert,
				process: { versions: { node: version } },
				Intl,
				EventTarget,
			});
		if (supported) expect(check).not.toThrow();
		else expect(check).toThrow();
	},
);

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
