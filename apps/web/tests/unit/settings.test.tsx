import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  createCustomerCredential: vi.fn(),
  listCustomerCredentials: vi.fn(),
  revokeCustomerCredential: vi.fn(),
}));
const selection = vi.hoisted(() => ({
  selectProject: vi.fn(),
  value: {
    projects: [{ id: "11111111-1111-4111-8111-111111111111", name: "Project One", slug: "project-one", created_at: "2026-07-16T10:00:00.000Z" }],
    selectedProjectId: "11111111-1111-4111-8111-111111111111",
    selectedProject: null,
    isLoading: false,
    error: null,
  },
}));

vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  ...api,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
  useProjectSelection: () => ({ ...selection.value, selectProject: selection.selectProject }),
}));

import { SettingsPage } from "../../src/routes/settings";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const credential = {
  id: "550e8400-e29b-41d4-a716-446655440000", project_id: PROJECT, display_name: "Renderer", prefix: "astraea_ck_ab", fingerprint: "123456789abc", scopes: ["prompts:read" as const], created_by: "admin", created_at: "2026-07-16T10:00:00.000Z", expires_at: null, revoked_at: null, last_used_at: null,
};

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>) };
}

describe("Settings customer credentials", () => {
  beforeEach(() => {
    window.localStorage.clear();
    selection.selectProject.mockReset();
    api.listCustomerCredentials.mockReset().mockResolvedValue({ items: [credential] });
    api.createCustomerCredential.mockReset().mockResolvedValue({ ...credential, secret: "astraea_ck_show_once" });
    api.revokeCustomerCredential.mockReset().mockResolvedValue({ ...credential, revoked_at: "2026-07-16T11:00:00.000Z" });
  });
  afterEach(cleanup);

  it("lists credentials, creates a scoped credential, and keeps its secret out of local storage", async () => {
    const { client } = renderSettings();
    expect(await screen.findByText("Renderer")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deploy renderer" } });
    fireEvent.click(screen.getByLabelText("Render prompts"));
    fireEvent.click(screen.getByTestId("create-credential"));

    await waitFor(() => expect(api.createCustomerCredential).toHaveBeenCalledWith({ project_id: PROJECT, display_name: "Deploy renderer", scopes: ["prompts:read", "prompts:render"], expires_at: null }));
    expect(await screen.findByTestId("credential-secret-value")).toHaveTextContent("astraea_ck_show_once");
    expect([...Array(window.localStorage.length)].map((_, index) => window.localStorage.getItem(window.localStorage.key(index)!))).not.toContain("astraea_ck_show_once");
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("astraea_ck_show_once");
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain("astraea_ck_show_once");
    fireEvent.click(screen.getByRole("button", { name: "I stored the secret" }));
    expect(screen.queryByTestId("credential-secret")).not.toBeInTheDocument();
  });

  it("requires confirmation before revoking a credential", async () => {
    renderSettings();
    await screen.findByText("Renderer");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("dialog", { name: "Revoke credential" })).toBeInTheDocument();
    expect(api.revokeCustomerCredential).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-revoke"));
    await waitFor(() => expect(api.revokeCustomerCredential).toHaveBeenCalledWith({ project_id: PROJECT, id: credential.id }));
  });
});
