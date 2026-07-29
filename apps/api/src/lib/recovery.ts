type InterruptedWork = { id: string; project_id: string };

type RecoveryDependencies = {
	pool: () => unknown;
	failExperiments: (pool: unknown) => Promise<InterruptedWork[]>;
	failOptimizations: (pool: unknown) => Promise<InterruptedWork[]>;
	log: (event: string, fields: Record<string, unknown>) => void;
};

export async function recoverInterruptedWork(
	dependencies: RecoveryDependencies,
): Promise<void> {
	const pool = dependencies.pool();
	const [experiments, optimizations] = await Promise.all([
		dependencies.failExperiments(pool),
		dependencies.failOptimizations(pool),
	]);
	dependencies.log("work.recovered_after_restart", {
		experiments_failed: experiments.length,
		optimizations_failed: optimizations.length,
	});
}
