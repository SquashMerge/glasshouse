type InterruptedWork = { id: string; project_id: string };
type RecoverableExperiment = {
	id: string;
	project_id: string;
	dataset_id: string;
	config: Record<string, unknown>;
};

type RecoveryDependencies = {
	pool: () => unknown;
	recoverExperiments: (pool: unknown) => Promise<RecoverableExperiment[]>;
	failOptimizations: (pool: unknown) => Promise<InterruptedWork[]>;
	resumeExperiment: (experiment: RecoverableExperiment) => Promise<void>;
	log: (event: string, fields: Record<string, unknown>) => void;
};

export async function recoverInterruptedWork(
	dependencies: RecoveryDependencies,
): Promise<void> {
	const pool = dependencies.pool();
	const [experiments, optimizations] = await Promise.all([
		dependencies.recoverExperiments(pool),
		dependencies.failOptimizations(pool),
	]);
	await Promise.all(
		experiments.map((experiment) => dependencies.resumeExperiment(experiment)),
	);
	dependencies.log("work.recovered_after_restart", {
		experiments_resumed: experiments.length,
		optimizations_failed: optimizations.length,
	});
}
