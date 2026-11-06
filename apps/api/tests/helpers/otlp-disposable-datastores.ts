export function otlpDisposableDatastores(
	env: NodeJS.ProcessEnv,
	database: string,
) {
	if (
		env.GLASSHOUSE_CONTAINER_NETWORK !== "1" ||
		env.NODE_ENV === "production" ||
		!/^otlp_extension_[0-9a-f]{32}$/.test(database) ||
		Object.entries(env).some(
			([key, value]) => key.startsWith("PG") && value !== undefined,
		) ||
		Object.entries({
			POSTGRES_HOST: "postgres",
			POSTGRES_PORT: "5432",
			CLICKHOUSE_HOST: "clickhouse",
			CLICKHOUSE_HTTP_PORT: "8123",
		}).some(
			([key, expected]) => env[key] !== undefined && env[key] !== expected,
		)
	)
		throw new Error("Private devcontainer datastores are required");
	const suppliedPg =
		env.DATABASE_URL === undefined
			? undefined
			: serviceUrl(env.DATABASE_URL, "postgres");
	const suppliedCh =
		env.CLICKHOUSE_URL === undefined
			? undefined
			: serviceUrl(env.CLICKHOUSE_URL, "clickhouse");
	// Only credentials cross from validated configuration into freshly pinned URLs.
	const pgUrl = new URL("postgresql://postgres:5432/postgres");
	pgUrl.username = encodeURIComponent(
		suppliedPg?.username
			? decodeURIComponent(suppliedPg.username)
			: (env.POSTGRES_USER ?? "postgres"),
	);
	pgUrl.password = encodeURIComponent(
		suppliedPg?.password
			? decodeURIComponent(suppliedPg.password)
			: (env.POSTGRES_PASSWORD ?? "postgres"),
	);
	if (!pgUrl.username) throw new Error("PostgreSQL test username is required");
	const postgresAdminUrl = pgUrl.toString();
	pgUrl.pathname = `/${database}`;
	const clickhouseAdminOptions = {
		url: "http://clickhouse:8123/",
		database: "default",
		username: suppliedCh?.username
			? decodeURIComponent(suppliedCh.username)
			: (env.CLICKHOUSE_USER ?? "glasshouse"),
		password: suppliedCh?.password
			? decodeURIComponent(suppliedCh.password)
			: (env.CLICKHOUSE_PASSWORD ?? ""),
	};
	return {
		postgresAdminUrl,
		postgresUrl: pgUrl.toString(),
		clickhouseAdminOptions,
		clickhouseOptions: { ...clickhouseAdminOptions, database },
	};
}

function serviceUrl(value: string, service: "postgres" | "clickhouse"): URL {
	try {
		const url = new URL(value);
		const postgres = service === "postgres";
		if (
			/[\s\\?#]/.test(value) ||
			url.hostname !== service ||
			(postgres
				? !["postgres:", "postgresql:"].includes(url.protocol)
				: url.protocol !== "http:") ||
			(postgres ? (url.port || "5432") !== "5432" : url.port !== "8123") ||
			(postgres
				? !/^\/[A-Za-z0-9_-]*$/.test(url.pathname)
				: url.pathname !== "/")
		)
			throw new Error();
		decodeURIComponent(url.username);
		decodeURIComponent(url.password);
		return url;
	} catch {
		throw new Error(
			"Private devcontainer datastore URL required; paths/options cannot override test targets",
		);
	}
}
