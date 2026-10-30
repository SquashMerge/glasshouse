export function hasNoSecretStorage(): boolean {
	return [localStorage, sessionStorage].every((storage) =>
		Object.keys(storage).every((key) => {
			if (storage === localStorage && key === "glasshouse.auth.invalidate")
				return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					storage.getItem(key) ?? "",
				);
			return !/auth|password|token|enrollment|secret/i.test(key);
		}),
	);
}
