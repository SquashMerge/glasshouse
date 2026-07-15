import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PromptComposer } from "../../src/routes/prompts-new";
import { setCredentials } from "../../src/lib/auth";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function prompt(version: number, source: string) {
  return {
    id: "support-agent",
    project_id: PROJECT_ID,
    name: "Support Agent",
    description: "Greets customers",
    version,
    role: "system" as const,
    source,
    model: "gpt-4o",
    settings: { temperature: 0.2 },
    change_summary: version === 1 ? "Initial version" : "Current version",
    created_by: "admin",
    created_at: "2026-07-15T10:00:00.000Z",
    content_hash: HASH,
    diff: null,
  };
}

function renderComposer(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("PromptComposer", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    setCredentials("admin", "secret");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("preserves a new prompt draft after settings validation fails, then creates version one without a client summary", async () => {
    const onSaved = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "support-agent", version: 1 }));
    renderComposer(<PromptComposer projectId={PROJECT_ID} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Support Agent" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Hello {{name}}" } });
    fireEvent.change(screen.getByLabelText("Settings JSON"), { target: { value: "[]" } });
    fireEvent.click(screen.getByTestId("save-prompt"));

    await screen.findByText("Settings must be a JSON object.");
    expect(screen.getByLabelText("Source")).toHaveValue("Hello {{name}}");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Settings JSON"), { target: { value: "{\"temperature\":0.2}" } });
    fireEvent.click(screen.getByTestId("save-prompt"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/prompts");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ project_id: PROJECT_ID, name: "Support Agent", description: null, role: "system", source: "Hello {{name}}", model: null, settings: { temperature: 0.2 } });
    expect(onSaved).toHaveBeenCalledWith({ id: "support-agent", version: 1 });
  });

  it("starts from the selected source, previews saved source with warnings, and submits against the current base version", async () => {
    const selected = prompt(1, "Selected {{customer}}");
    const current = prompt(3, "Current {{customer}}");
    const onSaved = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "support-agent", version: 1, role: "system", content_hash: HASH, output: "Selected ", warnings: [{ code: "MISSING_VARIABLE", path: "customer" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "support-agent", version: 4 }));
    renderComposer(<PromptComposer projectId={PROJECT_ID} existing={selected} current={current} onSaved={onSaved} />);

    await waitFor(() => expect(screen.getByLabelText("Source")).toHaveValue("Selected {{customer}}"));
    expect(screen.getByLabelText("Role")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Draft {{customer}}" } });
    fireEvent.change(screen.getByLabelText("Change summary"), { target: { value: "Use a shorter greeting" } });
    fireEvent.change(screen.getByLabelText("Variables JSON"), { target: { value: "{}" } });
    fireEvent.click(screen.getByTestId("preview-prompt"));

    await screen.findByTestId("preview-output");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/v1/prompts/support-agent/render?project_id=${PROJECT_ID}&version=1`);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ data: {} });
    expect(screen.getByTestId("preview-warnings")).toHaveTextContent("Missing variable: customer");
    expect(screen.getByTestId("preview-output")).toHaveTextContent("Selected");
    expect(screen.getByLabelText("Source")).toHaveValue("Draft {{customer}}");

    fireEvent.click(screen.getByTestId("save-prompt"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/v1/prompts/support-agent/versions?project_id=${PROJECT_ID}`);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ base_version: 3, source: "Draft {{customer}}", model: "gpt-4o", settings: { temperature: 0.2 }, change_summary: "Use a shorter greeting" });
    expect(onSaved).toHaveBeenCalledWith({ id: "support-agent", version: 4 });
  });
});
