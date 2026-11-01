import { createInternalLogCollector } from "../db/internal-logs.js";
import { pgPool } from "../db/postgres.js";
import { logger } from "./logger.js";

export const internalLogCollector = createInternalLogCollector(pgPool(), () =>
	logger.warn("internal_logs.collection_failed", {}),
);
