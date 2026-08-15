import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDatasetRouteHandlers } from "../../src/routes/datasets";
import {
	createExperimentHandlers,
	executeExperiment,
	type ExperimentDependencies,
} from "../../src/routes/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const datasetId = "22222222-2222-4222-8222-222222222222";
const experimentId = "33333333-3333-4333-8333-333333333333";
const organizationId = "44444444-4444-4444-8444-444444444444";
const actorId = "55555555-5555-4555-8555-555555555555";

const datasetsSource = readFileSync(
	resolve(import.meta.dir, "../../src/db/datasets.ts"),
	"utf8",
);
const experimentsSource = readFileSync(
	resolve(import.meta.dir, "../../src/db/experiments.ts"),
	"utf8",
);
const optimizationSource = readFileSync(
	resolve(import.meta.dir, "../../src/db/prompt-optimizations.ts"),
	"utf8",
);
const projectAuthorizationPath = resolve(
	import.meta.dir,
	"../../src/db/project-authorization.ts",
);
const projectAuthorizationSource = existsSync(projectAuthorizationPath)
	? readFileSync(projectAuthorizationPath, "utf8")
	: "";
const experimentMigrationPath = resolve(
	import.meta.dir,
	"../../../../infra/db/migrations/0042_experiment_requester_authorization.sql",
);
const experimentMigration = existsSync(experimentMigrationPath)
	? readFileSync(experimentMigrationPath, "utf8")
	: "";

function authorizedContext(valid: (part: string) => unknown) {
	return {
		get: () => ({
			actor: "user",
			actorId,
			organizationId,
		}),
		req: { valid },
		json: (body: unknown, status?: number) =>
			new Response(JSON.stringify(body), { status }),
	};
}

test("public dataset and experiment mutations pass the admitted actor to transactional persistence", async () => {
	let datasetInput: Record<string, unknown> | undefined;
	const datasets = createDatasetRouteHandlers({
		pool: () => ({}) as never,
		listDatasets: async () => ({ items: [], total: 0 }),
		createDataset: async (_pool: unknown, input: Record<string, unknown>) => {
			datasetInput = input;
			return {
				id: datasetId,
				project_id: projectId,
				name: "golden",
				description: null,
				item_count: 0,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
		},
		getDataset: async () => ({}) as never,
		listDatasetItems: async () => ({ items: [] }),
		addDatasetItem: async () => ({}) as never,
		deleteDatasetItem: async () => {},
		targetExists: async () => true,
	} as never);
	await datasets.handleCreateDataset(
		authorizedContext(() => ({
			project_id: projectId,
			name: "golden",
		})) as never,
	);

	let experimentInput: Record<string, unknown> | undefined;
	const experiments = createExperimentHandlers({
		pool: () => ({}) as never,
		assertProjectAccess: async () => {},
		createExperiment: async (
			_pool: unknown,
			input: Record<string, unknown>,
		) => {
			experimentInput = input;
			return {
				id: experimentId,
				project_id: projectId,
				dataset_id: datasetId,
				status: "pending",
				config: {},
			};
		},
		listExperiments: async () => ({ items: [], total: 0 }),
		getExperiment: async () => ({}) as never,
		updateExperiment: async () => ({ status: "cancelled" }) as never,
		cancelExperiment: async () => ({}) as never,
		listResults: async () => ({ items: [] }) as never,
		insertResult: async () => ({}) as never,
		claimTask: async () => null,
		nextTaskRetryDelay: async () => null,
		waitForTaskRetry: async () => {},
		finalizeTask: async () => false,
		completeExperiment: async () => false,
		summary: async () => ({}) as never,
		getDataset: async () => ({ id: datasetId }) as never,
		listPublishedDatasetItems: async () => ({
			items: [{ id: "case", input: {}, expected_output: {} }],
		}),
		invokeLlm: async () => ({ output: {}, model: "test" }),
		trace: async () => {},
	} as never);
	await experiments.handleCreateExperiment(
		authorizedContext(() => ({
			project_id: projectId,
			dataset_id: datasetId,
			config: {},
		})) as never,
	);

	expect(datasetInput?.authorization).toEqual({
		organization_id: organizationId,
		actor_id: actorId,
		operation: "product_write",
	});
	expect(experimentInput?.authorization).toEqual({
		organization_id: organizationId,
		actor_id: actorId,
		operation: "execute",
	});
});

test("all dataset mutations authorize inside their project FOR UPDATE decision", () => {
	for (const name of ["createDataset", "addDatasetItem", "deleteDatasetItem"]) {
		const start = datasetsSource.indexOf(`export async function ${name}`);
		const next = datasetsSource.indexOf("export async function", start + 1);
		const mutation = datasetsSource.slice(
			start,
			next === -1 ? undefined : next,
		);
		expect(mutation).toContain("lockActiveAuthorizedProject");
		expect(mutation).toContain("input.authorization");
	}
	expect(projectAuthorizationSource).toContain("authorization_allows_project");
	expect(projectAuthorizationSource).toContain("FOR UPDATE OF p");
});

test("experiments retain an organization-scoped requester and revoke unsafe historical work", () => {
	expect(experimentMigration).toContain("requested_by_actor_id UUID");
	expect(experimentMigration).toContain("actor_identities");
	expect(experimentMigration).toContain("requested_by_actor_id IS NULL");
	expect(experimentsSource).toContain("requested_by_actor_id");
	for (const name of [
		"claimExperimentTask",
		"finalizeExperimentTask",
		"completeExperimentIfTasksFinished",
	]) {
		const start = experimentsSource.indexOf(`export async function ${name}`);
		const next = experimentsSource.indexOf("export async function", start + 1);
		const mutation = experimentsSource.slice(
			start,
			next === -1 ? undefined : next,
		);
		expect(mutation).toContain("lockExperimentExecution");
	}
	const recoveryStart = experimentsSource.indexOf(
		"export async function listRecoverableExperiments",
	);
	const recoveryEnd = experimentsSource.indexOf(
		"export async function",
		recoveryStart + 1,
	);
	const recovery = experimentsSource.slice(recoveryStart, recoveryEnd);
	expect(recovery).toContain("lockExperimentExecution");
	expect(recovery).toContain("cancelRevokedExperiment");
});

test("optimization worker claims and finalization freshly lock the requester authorization", () => {
	for (const name of [
		"claimOptimizationJob",
		"renewOptimizationJobLease",
		"recordOptimizationMetricCalls",
		"transitionOptimizationJob",
		"completeOptimizationResult",
		"publishOptimizationResult",
	]) {
		const start = optimizationSource.indexOf(`export async function ${name}`);
		const next = optimizationSource.indexOf("export async function", start + 1);
		const mutation = optimizationSource.slice(
			start,
			next === -1 ? undefined : next,
		);
		expect(mutation).toContain("lockOptimizationExecution");
	}
});

test("revocation before claim prevents provider execution", async () => {
	let providerCalls = 0;
	let authorizationChecks = 0;
	let claimed = false;
	const dependencies = {
		pool: () => ({}) as never,
		updateExperiment: async () => ({ status: "running" }) as never,
		claimTask: async () => {
			if (claimed) return null;
			claimed = true;
			return {
				id: "task",
				dataset_item_id: datasetId,
				lease_token: "66666666-6666-4666-8666-666666666666",
				input: { question: "one" },
				expected_output: { value: "one" },
			};
		},
		admitExecution: async () => {
			authorizationChecks += 1;
			return null;
		},
		isAdmissionActive: async () => false,
		cancelAdmission: async () => {},
		completeAdmission: async () => {},
		finalizeTask: async () => true,
		completeExperiment: async () => true,
		invokeLlm: async () => {
			providerCalls += 1;
			return { output: { value: "one" }, model: "test" };
		},
		trace: async () => {},
	} as unknown as ExperimentDependencies;

	await executeExperiment(dependencies, {
		project_id: projectId,
		experiment_id: experimentId,
		dataset_id: datasetId,
		config: {},
	});

	expect(authorizationChecks).toBeGreaterThan(0);
	expect(providerCalls).toBe(0);
});

test("revocation observed at execution admission prevents provider invocation and traces", async () => {
	let providerCalls = 0;
	let traceCalls = 0;
	let claimed = false;
	const dependencies = {
		pool: () => ({}) as never,
		updateExperiment: async () => ({ status: "running" }) as never,
		claimTask: async () => {
			if (claimed) return null;
			claimed = true;
			return {
				id: "task",
				dataset_item_id: datasetId,
				lease_token: "66666666-6666-4666-8666-666666666666",
				input: { question: "one" },
				expected_output: { value: "one" },
			};
		},
		admitExecution: async () => null,
		isAdmissionActive: async () => false,
		cancelAdmission: async () => {},
		completeAdmission: async () => {},
		finalizeTask: async () => true,
		completeExperiment: async () => true,
		invokeLlm: async () => {
			providerCalls += 1;
			return { output: { value: "one" }, model: "test" };
		},
		trace: async () => {
			traceCalls += 1;
		},
	} as unknown as ExperimentDependencies;

	await executeExperiment(dependencies, {
		project_id: projectId,
		experiment_id: experimentId,
		dataset_id: datasetId,
		config: {},
	});

	expect(providerCalls).toBe(0);
	expect(traceCalls).toBe(0);
});

test("revocation during in-flight persistence prevents result and trace writes", async () => {
	let providerCalls = 0;
	let traceCalls = 0;
	let authorizationChecks = 0;
	let claimed = false;
	const dependencies = {
		pool: () => ({}) as never,
		updateExperiment: async () => ({ status: "running" }) as never,
		claimTask: async () => {
			if (claimed) return null;
			claimed = true;
			return {
				id: "task",
				dataset_item_id: datasetId,
				lease_token: "66666666-6666-4666-8666-666666666666",
				input: { question: "one" },
				expected_output: { value: "one" },
			};
		},
		admitExecution: async () => {
			authorizationChecks += 1;
			return {
				id: "77777777-7777-4777-8777-777777777777",
				project_id: projectId,
				requester_actor_id: "88888888-8888-4888-8888-888888888888",
				authorization_epoch: 1,
			};
		},
		isAdmissionActive: async () => true,
		claimExecution: async () => ({ status: "created" as const }),
		cancelAdmission: async () => {},
		completeAdmission: async () => {},
		finalizeTask: async () => false,
		completeExperiment: async () => true,
		invokeLlm: async () => {
			providerCalls += 1;
			return { output: { value: "one" }, model: "test" };
		},
		trace: async () => {
			traceCalls += 1;
		},
	} as unknown as ExperimentDependencies;

	await executeExperiment(dependencies, {
		project_id: projectId,
		experiment_id: experimentId,
		dataset_id: datasetId,
		config: {},
	});

	expect(authorizationChecks).toBeGreaterThan(0);
	expect(providerCalls).toBe(1);
	expect(traceCalls).toBe(0);
});
