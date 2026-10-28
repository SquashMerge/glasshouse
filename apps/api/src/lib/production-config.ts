const MIN_SECRET_LENGTH = 20;

export type ProductionEnvironment = Record<string, string | undefined>;

function required(environment: ProductionEnvironment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required in production`);
	return value;
}

function requireStrongSecret(
	environment: ProductionEnvironment,
	name: string,
): void {
	const value = required(environment, name);
	if (
		value.length < MIN_SECRET_LENGTH ||
		value.includes("CHANGE_ME") ||
		new Set(value).size < 8
	)
		throw new Error(
			`${name} must be a non-placeholder production secret with at least ${MIN_SECRET_LENGTH} characters and 8 distinct characters`,
		);
}

export function assertProductionConfiguration(
	environment: ProductionEnvironment = process.env,
): void {
	if (environment.NODE_ENV !== "production")
		throw new Error("NODE_ENV must be exactly production");

	for (const name of [
		"POSTGRES_PASSWORD",
		"CLICKHOUSE_PASSWORD",
		"VALKEY_PASSWORD",
		"UI_PASSWORD",
	])
		requireStrongSecret(environment, name);
	const postgresPassword = required(environment, "POSTGRES_PASSWORD");
	if (!/^[A-Za-z0-9._~-]+$/.test(postgresPassword))
		throw new Error(
			"POSTGRES_PASSWORD must use only URL-unreserved ASCII characters because it is embedded in DATABASE_URL",
		);
	required(environment, "GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME");

	const publicOrigin = required(environment, "GLASSHOUSE_PUBLIC_ORIGIN");
	let parsedOrigin: URL;
	try {
		parsedOrigin = new URL(publicOrigin);
	} catch {
		throw new Error(
			"GLASSHOUSE_PUBLIC_ORIGIN must be an absolute HTTPS origin",
		);
	}
	if (
		parsedOrigin.protocol !== "https:" ||
		parsedOrigin.pathname !== "/" ||
		parsedOrigin.search ||
		parsedOrigin.hash ||
		!parsedOrigin.hostname
	)
		throw new Error(
			"GLASSHOUSE_PUBLIC_ORIGIN must be an absolute HTTPS origin",
		);

	if (environment.GEPA_WORKER_MODE === "cli")
		throw new Error("GEPA_WORKER_MODE=cli is not allowed in production");
	if (environment.GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION === "true")
		throw new Error("development LLM overrides are not allowed in production");
}
