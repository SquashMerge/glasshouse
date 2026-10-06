import { expect, test } from "bun:test";

const projectRoutesSource = await Bun.file(
	new URL("../../src/routes/projects.ts", import.meta.url),
).text();

test("project mutation CTEs avoid the reserved AUTHORIZATION identifier", () => {
	const reservedAuthorizationCtes = projectRoutesSource.match(
		/\bWITH\s+authorization\s+AS\s+MATERIALIZED\b/gi,
	);

	expect(reservedAuthorizationCtes).toBeNull();
});
