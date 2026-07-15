import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: { searchStr: "" },
}));
const { getPrompt, listPromptVersions, deletePrompt } = vi.hoisted(() => ({
  getPrompt: vi.fn(),
  listPromptVersions: vi.fn(),
  deletePrompt: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useParams: () => ({ slug: "support-agent" }),
    useLocation: () => router.location,
    useNavigate: () => router.navigate,
  };
});
vi.mock("../../src/components/ProjectProvider", () => ({
  useProjectSelection: () => ({ selectedProjectId: "11111111-1111-4111-8111-111111111111", selectedProject: { id: "11111111-1111-4111-8111-111111111111", name: "Project One" } }),
}));
vi.mock("../../src/lib/api", () => ({ getPrompt, listPromptVersions, deletePrompt }));

import { PromptDetailPage } from "../../src/routes/prompts-detail";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function prompt(version = 3) {
  return {
    id: "support-agent",
    project_id: PROJECT_ID,
    name: "Support Agent",
    description: null,
    version,
    role: "system" as const,
    source: "Current {{customer}}",
    model: "gpt-4o",
    settings: { temperature: 0.2 },
    change_summary: "Current version",
    created_by: "admin",
    created_at: "2026-07-15T10:00:00.000Z",
    content_hash: HASH,
    diff: "--- v2\n+++ v3\n+Current {{customer}}",
  };
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["prompts", PROJECT_ID], { items: [], total: 0 });
  render(<QueryClientProvider client={client}><PromptDetailPage /></QueryClientProvider>);
  return client;
}

describe("PromptDetailPage", () => {
  beforeEach(() => {
    router.navigate.mockReset();
    router.location.searchStr = "";
    getPrompt.mockReset();
    listPromptVersions.mockReset();
    deletePrompt.mockReset();
    getPrompt.mockResolvedValue(prompt());
    listPromptVersions.mockResolvedValue({ items: [prompt(), { ...prompt(2), source: "Previous {{customer}}", change_summary: "Previous version", diff: "--- v1\n+++ v2" }] });
  });

  afterEach(cleanup);

  it("shows immutable version details and drives history selection through the version query", async () => {
    renderDetail();

    await screen.findByTestId("prompt-source");
    expect(screen.getByTestId("prompt-source")).toHaveTextContent("Current {{customer}}");
    expect(screen.getByTestId("prompt-diff")).toHaveTextContent("+++ v3");
    expect(screen.getByText(HASH)).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId("prompt-version")[1]!);

    expect(router.navigate).toHaveBeenLastCalledWith({ to: "/prompts/$slug", params: { slug: "support-agent" }, search: { version: 2 } });
  });

  it("requires the exact canonical slug, reports delete errors, then invalidates the prompt list and navigates", async () => {
    const client = renderDetail();
    await screen.findByTestId("prompt-source");
    deletePrompt.mockRejectedValueOnce(new Error("Prompt has active references"));
    deletePrompt.mockResolvedValueOnce(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByTestId("delete-confirmation");
    const confirmButton = screen.getByTestId("confirm-delete");
    expect(confirmButton).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "DELETE support-agent" } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "support-agent" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await screen.findByText("Prompt has active references");
    expect(deletePrompt).toHaveBeenCalledWith({ project_id: PROJECT_ID, slug: "support-agent", confirmation: "support-agent" });

    fireEvent.click(confirmButton);
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: "/prompts" }));
    expect(client.getQueryState(["prompts", PROJECT_ID])?.isInvalidated).toBe(true);
  });
});
