import "./setup";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hasNoSecretStorage } from "../e2e/secret-storage";

const invalidationKey = "glasshouse.auth.invalidate";
const uuid = "11111111-1111-4111-8111-111111111111";

function clearStorage() {
	localStorage.clear();
	sessionStorage.clear();
}
beforeEach(clearStorage);
afterEach(clearStorage);

it("allows only a localStorage UUID invalidation signal alongside safe preferences", () => {
	localStorage.setItem(invalidationKey, uuid);
	localStorage.setItem("glasshouse.nav.collapsed", "1");
	expect(hasNoSecretStorage()).toBe(true);
});

it("does not allow the invalidation key in sessionStorage, even with a UUID", () => {
	sessionStorage.setItem(invalidationKey, uuid);
	expect(hasNoSecretStorage()).toBe(false);
});

it.each(["", "test-only-secret", `${uuid}extra`, "not-a-uuid"])(
	"rejects a malformed invalidation signal (%j)",
	(value) => {
		localStorage.setItem(invalidationKey, value);
		expect(hasNoSecretStorage()).toBe(false);
	},
);

for (const storage of ["localStorage", "sessionStorage"] as const) {
	it.each([
		"glasshouse.auth.username",
		"glasshouse.auth.password",
		"password",
		"csrf_token",
		"enrollment",
		"SECRET",
		`${invalidationKey}.token`,
		invalidationKey.toUpperCase(),
	])(`rejects credential/secret keys in ${storage} (%s)`, (key) => {
		localStorage.setItem(invalidationKey, uuid);
		window[storage].setItem(key, uuid);
		expect(hasNoSecretStorage()).toBe(false);
	});
}
