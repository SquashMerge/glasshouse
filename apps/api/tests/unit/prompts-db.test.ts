import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import { MAX_DIFF_INPUT_CHARS, MAX_PROMPT_SOURCE_CHARS } from "../../src/lib/prompt-limits";
import {
  createPrompt,
  createPromptVersion,
  deletePrompt,
  getPrompt,
  listProjects,
  listPromptVersions,
  normalizePromptSlug,
  promptProvenanceStatus,
  PromptRepositoryError,
  renderPrompt,
  textualVersionDiff,
} from "../../src/db/prompts";

type Reply = { rows: Record<string, unknown>[] } | { error: unknown };
type QueryCall = { text: string; values: unknown[] };

class MockClient {
  readonly calls: QueryCall[] = [];
  released = false;

  constructor(private readonly replies: Reply[]) {}

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, values });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`Unexpected query: ${text}`);
    if ("error" in reply) throw reply.error;
    return reply;
  }

  release(): void {
    this.released = true;
  }
}

class MockPool {
  readonly calls: QueryCall[] = [];
  readonly client: MockClient;

  constructor(readReplies: Reply[] = [], transactionReplies: Reply[] = []) {
    this.readReplies = readReplies;
    this.client = new MockClient(transactionReplies);
  }

  private readonly readReplies: Reply[];

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, values });
    const reply = this.readReplies.shift();
    if (!reply) throw new Error(`Unexpected query: ${text}`);
    if ("error" in reply) throw reply.error;
    return reply;
  }

  async connect(): Promise<MockClient> {
    return this.client;
  }
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-07-15T10:00:00.000Z";
const HASH = "a".repeat(64);

const versionRow = {
  slug: "support-agent",
  role: "system",
  version: 2,
  source: "Current {{customer}}",
  model: "gpt-test",
  settings: { temperature: 0.4 },
  change_summary: "Clarify customer context",
  created_by: "trusted-admin",
  created_at: CREATED_AT,
  content_hash: HASH,
  previous_source: "Previous {{customer}}",
};

function transactionPool(pool: MockPool): Pick<Pool, "connect"> {
  return pool as unknown as Pick<Pool, "connect">;
}

function readPool(pool: MockPool): Pick<Pool, "query"> {
  return pool as unknown as Pick<Pool, "query">;
}

async function expectError(action: Promise<unknown>, code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT"): Promise<void> {
  try {
    await action;
    throw new Error("Expected PromptRepositoryError");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PromptRepositoryError);
    expect((cause as PromptRepositoryError).code).toBe(code);
  }
}

describe("prompt repository", () => {
  it("lists every existing project for the global trusted administrator", async () => {
    const pool = new MockPool([
      { rows: [{ total: "2" }] },
      { rows: [
        { id: PROJECT, name: "Project One", slug: "project-one", created_at: CREATED_AT },
        { id: OTHER_PROJECT, name: "Project Two", slug: "project-two", created_at: CREATED_AT },
      ] },
    ]);

    expect(await listProjects(readPool(pool))).toEqual({
      total: 2,
      items: [
        { id: PROJECT, name: "Project One", slug: "project-one", created_at: CREATED_AT },
        { id: OTHER_PROJECT, name: "Project Two", slug: "project-two", created_at: CREATED_AT },
      ],
    });
    expect(pool.calls[1]?.text).toContain("FROM projects ORDER BY slug ASC");
  });

  it("normalizes canonical slugs and generates a dependency-free textual diff", () => {
    expect(normalizePromptSlug("  Support__Agent !!  ")).toBe("support-agent");
    expect(normalizePromptSlug(" !!! ")).toBe("prompt");
    expect(normalizePromptSlug("a".repeat(80))).toBe("a".repeat(64));
    expect(textualVersionDiff("one\ntwo", "one\nthree")).toBe("--- previous\n+++ current\n one\n+three\n-two");
    try {
      textualVersionDiff("x".repeat(MAX_DIFF_INPUT_CHARS + 1), "changed");
      throw new Error("Expected PromptRepositoryError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PromptRepositoryError);
      expect((cause as PromptRepositoryError).code).toBe("BAD_REQUEST");
      expect((cause as PromptRepositoryError).message).toContain("Prompt diff previous source exceeds");
    }
    try {
      textualVersionDiff(`${"x\n".repeat(512)}x`, "changed");
      throw new Error("Expected PromptRepositoryError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PromptRepositoryError);
      expect((cause as PromptRepositoryError).message).toContain("Prompt diff previous source exceeds 512 lines");
    }
  });

  it("rejects oversized new source before opening a transaction while keeping legacy retrieval independent", async () => {
    const pool = new MockPool();
    await expectError(createPrompt(transactionPool(pool), {
      project_id: PROJECT,
      name: "Support Agent",
      role: "system",
      source: "x".repeat(MAX_PROMPT_SOURCE_CHARS + 1),
      actor: "trusted-admin",
    }), "BAD_REQUEST");
    expect(pool.client.calls).toHaveLength(0);
  });

  it("creates a role-matched canonical source snapshot with context actor and no public UUID", async () => {
    const pool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{ project_id: PROJECT, name: "Support Agent", slug: "support-agent", description: null }] },
      { rows: [{ ...versionRow, slug: "support-agent", version: 1, source: "Help {{customer}}", previous_source: null, model: null, settings: {}, change_summary: "Initial version" }] },
      { rows: [] },
    ]);

    const result = await createPrompt(transactionPool(pool), {
      project_id: PROJECT,
      name: "Support Agent",
      role: "system",
      source: "Help {{customer}}",
      actor: "trusted-admin",
    });

    expect(result).toEqual({
      id: "support-agent",
      project_id: PROJECT,
      name: "Support Agent",
      description: null,
      version: 1,
      role: "system",
      source: "Help {{customer}}",
      model: null,
      settings: {},
      change_summary: "Initial version",
      created_by: "trusted-admin",
      created_at: CREATED_AT,
      content_hash: HASH,
      diff: null,
    });
    expect(JSON.stringify(result)).not.toContain("internal-prompt-id");
    expect(pool.client.calls[2]?.text).toContain("pg_advisory_xact_lock");
    expect(pool.client.calls[2]?.values).toEqual([`prompt:${PROJECT}:support-agent`]);
    expect(pool.client.calls[6]?.values?.slice(1, 8)).toEqual([
      1,
      "Help {{customer}}",
      null,
      "{}",
      '[{"role":"system","content":"Help {{customer}}"}]',
      "Initial version",
      "trusted-admin",
    ]);
    expect(pool.client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("FROM projects WHERE id = $1 FOR UPDATE"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("prompt_tombstones"),
      expect.stringContaining("FROM prompts"),
      expect.stringContaining("INSERT INTO prompts"),
      expect.stringContaining("INSERT INTO prompt_versions"),
      "COMMIT",
    ]);
  });

  it("uses stable numeric candidates when a project-local slug collides", async () => {
    const pool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ slug: "support-agent" }] },
      { rows: [] },
      { rows: [{ slug: "support-agent-2" }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ project_id: PROJECT, name: "Support Agent", slug: "support-agent-3", description: null }] },
      { rows: [{ ...versionRow, slug: "support-agent-3", version: 1, source: "source", previous_source: null, model: null, settings: {}, change_summary: "Initial version" }] },
      { rows: [] },
    ]);

    const result = await createPrompt(transactionPool(pool), {
      project_id: PROJECT,
      name: "Support Agent",
      role: "system",
      source: "source",
      actor: "trusted-admin",
    });

    expect(result.id).toBe("support-agent-3");
    expect(result.id.length).toBeLessThanOrEqual(64);
    expect(pool.client.calls[5]?.values).toEqual([PROJECT, "support-agent-2"]);
    expect(pool.client.calls[6]?.values).toEqual([PROJECT, "support-agent-2"]);
    expect(pool.client.calls[7]?.values).toEqual([PROJECT, "support-agent-3"]);
    expect(pool.client.calls[9]?.values?.[3]).toBe("support-agent-3");

    const longName = "a".repeat(64);
    const longPool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ slug: longName }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ project_id: PROJECT, name: longName, slug: `${"a".repeat(62)}-2`, description: null }] },
      { rows: [{ ...versionRow, slug: `${"a".repeat(62)}-2`, version: 1, source: "source", previous_source: null, model: null, settings: {}, change_summary: "Initial version" }] },
      { rows: [] },
    ]);
    const longResult = await createPrompt(transactionPool(longPool), {
      project_id: PROJECT,
      name: longName,
      role: "system",
      source: "source",
      actor: "trusted-admin",
    });
    expect(longResult.id).toBe(`${"a".repeat(62)}-2`);
    expect(longResult.id).toHaveLength(64);
  });

  it("prohibits recreation of a tombstoned canonical slug", async () => {
    const pool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [] },
      { rows: [{ slug: "support-agent" }] },
      { rows: [] },
    ]);

    await expectError(createPrompt(transactionPool(pool), {
      project_id: PROJECT,
      name: "Support Agent",
      role: "system",
      source: "source",
      actor: "trusted-admin",
    }), "CONFLICT");
    expect(pool.client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("FROM projects WHERE id = $1 FOR UPDATE"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("prompt_tombstones"),
      "ROLLBACK",
    ]);
  });

  it("inherits omitted model and settings, replaces explicit settings, and rejects stale bases", async () => {
    const inheritancePool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [{ id: "internal-prompt-id", slug: "support-agent", role: "system" }] },
      { rows: [{ version: 2, model: "gpt-test", settings: { temperature: 0.4 } }] },
      { rows: [{ ...versionRow, version: 3, source: "new source", previous_source: null }] },
      { rows: [] },
    ]);

    const inherited = await createPromptVersion(transactionPool(inheritancePool), {
      project_id: PROJECT,
      slug: "support-agent",
      base_version: 2,
      source: "new source",
      change_summary: "Add detail",
      actor: "trusted-admin",
    });

    expect(inherited.version).toBe(3);
    expect(inheritancePool.client.calls[4]?.values?.slice(1, 6)).toEqual([
      3,
      "new source",
      "gpt-test",
      '{"temperature":0.4}',
      '[{"role":"system","content":"new source"}]',
    ]);

    const stalePool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [{ id: "internal-prompt-id", slug: "support-agent", role: "system" }] },
      { rows: [{ version: 3, model: null, settings: {} }] },
      { rows: [] },
    ]);
    await expectError(createPromptVersion(transactionPool(stalePool), {
      project_id: PROJECT,
      slug: "support-agent",
      base_version: 2,
      source: "new source",
      model: null,
      settings: {},
      change_summary: "Reset model and settings",
      actor: "trusted-admin",
    }), "CONFLICT");
    expect(stalePool.client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      expect.stringContaining("FROM projects WHERE id = $1 FOR UPDATE"),
      expect.stringContaining("FROM prompts"),
      expect.stringContaining("FROM prompt_versions"),
      "ROLLBACK",
    ]);

    const replacementPool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [{ id: "internal-prompt-id", slug: "support-agent", role: "system" }] },
      { rows: [{ version: 2, model: "gpt-test", settings: { temperature: 0.4 } }] },
      { rows: [{ ...versionRow, version: 3, source: "cleared source", model: null, settings: {}, previous_source: null }] },
      { rows: [] },
    ]);
    const cleared = await createPromptVersion(transactionPool(replacementPool), {
      project_id: PROJECT,
      slug: "support-agent",
      base_version: 2,
      source: "cleared source",
      model: null,
      settings: {},
      change_summary: "Clear model and settings",
      actor: "trusted-admin",
    });
    expect(cleared.model).toBeNull();
    expect(cleared.settings).toEqual({});
    expect(replacementPool.client.calls[4]?.values?.slice(3, 5)).toEqual([null, "{}"]);

    const invalidSettingsPool = new MockPool();
    await expectError(createPromptVersion(transactionPool(invalidSettingsPool), {
      project_id: PROJECT,
      slug: "support-agent",
      base_version: 2,
      source: "source",
      settings: null as never,
      change_summary: "Reject null settings",
      actor: "trusted-admin",
    }), "BAD_REQUEST");
    expect(invalidSettingsPool.client.calls).toHaveLength(0);
  });

  it("returns exact canonical source and version history only through project-scoped queries", async () => {
    const getPool = new MockPool([
      { rows: [{ id: PROJECT }] },
      { rows: [{ ...versionRow, project_id: PROJECT, name: "Support Agent", description: "Helpful" }] },
    ]);
    const prompt = await getPrompt(readPool(getPool), { project_id: PROJECT, slug: "support-agent", version: 2 });

    expect(prompt.source).toBe("Current {{customer}}");
    expect(prompt.diff).toBe("--- previous\n+++ current\n+Current {{customer}}\n-Previous {{customer}}");
    expect(getPool.calls[1]?.values).toEqual([PROJECT, "support-agent", 2]);
    expect(getPool.calls[1]?.text).toContain("p.project_id = $1 AND p.slug = $2");
    expect(JSON.stringify(prompt)).not.toContain("internal-prompt-id");

    const malformedPool = new MockPool([
      { rows: [{ id: PROJECT }] },
      { rows: [{ ...versionRow, project_id: PROJECT, name: "Legacy Prompt", description: null, version: 1, source: "Malformed {{template", previous_source: null }] },
    ]);
    const malformed = await getPrompt(readPool(malformedPool), { project_id: PROJECT, slug: "support-agent", version: 1 });
    expect(malformed.source).toBe("Malformed {{template");

    const oversizedLegacyPool = new MockPool([
      { rows: [{ id: PROJECT }] },
      { rows: [{ ...versionRow, project_id: PROJECT, name: "Legacy Prompt", description: null, source: "current legacy source", previous_source: "x".repeat(MAX_DIFF_INPUT_CHARS + 1) }] },
    ]);
    const oversizedLegacy = await getPrompt(readPool(oversizedLegacyPool), { project_id: PROJECT, slug: "support-agent", version: 2 });
    expect(oversizedLegacy.source).toBe("current legacy source");
    expect(oversizedLegacy.diff).toBeNull();

    const historyPool = new MockPool([
      { rows: [{ id: PROJECT }] },
      { rows: [versionRow, { ...versionRow, version: 1, source: "Previous {{customer}}", previous_source: null }] },
    ]);
    const history = await listPromptVersions(readPool(historyPool), { project_id: PROJECT, slug: "support-agent" });
    expect(history.items.map((item) => item.version)).toEqual([2, 1]);
    expect(history.items[0]?.source).toBe("Current {{customer}}");
    expect(historyPool.calls[1]?.values).toEqual([PROJECT, "support-agent"]);
  });

  it("does not reveal a prompt from another project", async () => {
    const pool = new MockPool([
      { rows: [{ id: OTHER_PROJECT }] },
      { rows: [] },
    ]);

    await expectError(getPrompt(readPool(pool), { project_id: OTHER_PROJECT, slug: "support-agent" }), "NOT_FOUND");
    expect(pool.calls[1]?.values).toEqual([OTHER_PROJECT, "support-agent"]);
  });

  it("renders stored source as plain LLM text with deterministic missing-variable warnings", async () => {
    const pool = new MockPool([
      { rows: [{ id: PROJECT }] },
      { rows: [{
        ...versionRow,
        project_id: PROJECT,
        name: "Support Agent",
        description: null,
        version: 1,
        source: "Hello {{customer}} {{missing}}",
        previous_source: null,
      }] },
    ]);
    const rendered = await renderPrompt(readPool(pool), {
      project_id: PROJECT,
      slug: "support-agent",
      data: { customer: "<&>" },
    });

    expect(rendered).toEqual({
      id: "support-agent",
      version: 1,
      role: "system",
      content_hash: HASH,
      output: "Hello <&> ",
      warnings: [{ code: "MISSING_VARIABLE", path: "missing" }],
    });

    const oversizedSourcePool = new MockPool([
      { rows: [{ id: PROJECT }] },
      { rows: [{ ...versionRow, project_id: PROJECT, name: "Legacy Prompt", description: null, source: "x".repeat(MAX_PROMPT_SOURCE_CHARS + 1), previous_source: null }] },
    ]);
    await expectError(renderPrompt(readPool(oversizedSourcePool), {
      project_id: PROJECT,
      slug: "support-agent",
      data: {},
    }), "BAD_REQUEST");
  });

  it("requires raw slug confirmation and only deletes same-project quarantine data with the prompt", async () => {
    const rejectedPool = new MockPool();
    await expectError(deletePrompt(transactionPool(rejectedPool), {
      project_id: PROJECT,
      slug: "support-agent",
      confirmation: "support-agent@2",
      actor: "trusted-admin",
    }), "BAD_REQUEST");
    expect(rejectedPool.client.calls).toHaveLength(0);

    const pool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ id: "internal-prompt-id", slug: "support-agent" }] },
      { rows: [{ total: "2" }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
    await deletePrompt(transactionPool(pool), {
      project_id: PROJECT,
      slug: "support-agent",
      confirmation: "support-agent",
      actor: "trusted-admin",
    });

    expect(pool.client.calls[2]?.text).toContain("pg_advisory_xact_lock");
    expect(pool.client.calls[2]?.values).toEqual([`prompt:${PROJECT}:support-agent`]);
    expect(pool.client.calls[6]?.text).toContain("DELETE FROM prompt_labels");
    expect(pool.client.calls[7]?.text).toContain("DELETE FROM prompt_label_quarantine");
    expect(pool.client.calls[7]?.text).toContain("original_project_id = $2");
    expect(pool.client.calls[7]?.values).toEqual(["internal-prompt-id", PROJECT]);
    expect(pool.client.calls[8]?.text).toContain("prompt_deletion_audit (project_id, prompt_id, slug, deleted_by, deleted_version_count)");
    expect(pool.client.calls[8]?.text).not.toContain("content");
    expect(pool.client.calls[8]?.text).not.toContain("settings");
    expect(pool.client.calls[8]?.values).toEqual([PROJECT, "internal-prompt-id", "support-agent", "trusted-admin", 2]);
    expect(pool.client.calls[9]?.text).toContain("INSERT INTO prompt_tombstones");
    expect(pool.client.calls[10]?.text).toContain("DELETE FROM prompts");
    expect(pool.client.released).toBe(true);
  });

  it("returns conflicts for tombstoned deletion and resolves provenance as deleted before historical tuple checks", async () => {
    const deletePool = new MockPool([], [
      { rows: [] },
      { rows: [{ id: PROJECT }] },
      { rows: [] },
      { rows: [{ slug: "support-agent" }] },
      { rows: [] },
    ]);
    await expectError(deletePrompt(transactionPool(deletePool), {
      project_id: PROJECT,
      slug: "support-agent",
      confirmation: "support-agent",
      actor: "trusted-admin",
    }), "CONFLICT");
    expect(deletePool.client.calls[4]?.text).toBe("ROLLBACK");

    const statusPool = new MockPool([{ rows: [{ id: PROJECT }] }, { rows: [{ status: "deleted" }] }]);
    expect(await promptProvenanceStatus(readPool(statusPool), {
      project_id: PROJECT,
      slug: "support-agent",
      version: 99,
      content_hash: "b".repeat(64),
    })).toBe("deleted");
    expect(statusPool.calls).toHaveLength(2);

    expect(statusPool.calls[1]?.text).toContain("SELECT CASE");
    expect(statusPool.calls[1]?.text).toContain("prompt_tombstones");
    expect(statusPool.calls[1]?.text).toContain("INNER JOIN prompt_versions");

    const activePool = new MockPool([{ rows: [{ id: PROJECT }] }, { rows: [{ status: "active" }] }]);
    expect(await promptProvenanceStatus(readPool(activePool), {
      project_id: PROJECT,
      slug: "support-agent",
      version: 2,
      content_hash: HASH,
    })).toBe("active");

    const unknownPool = new MockPool([{ rows: [{ id: PROJECT }] }, { rows: [{ status: "unknown" }] }]);
    expect(await promptProvenanceStatus(readPool(unknownPool), {
      project_id: PROJECT,
      slug: "support-agent",
      version: 2,
      content_hash: HASH,
    })).toBe("unknown");
    expect(activePool.calls).toHaveLength(2);
    expect(unknownPool.calls).toHaveLength(2);

    const missingProjectPool = new MockPool([{ rows: [] }]);
    await expectError(promptProvenanceStatus(readPool(missingProjectPool), {
      project_id: OTHER_PROJECT,
      slug: "support-agent",
      version: 2,
      content_hash: HASH,
    }), "NOT_FOUND");
    expect(missingProjectPool.calls).toHaveLength(1);
  });
});
