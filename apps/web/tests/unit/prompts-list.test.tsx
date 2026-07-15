import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

const { listPrompts } = vi.hoisted(() => ({ listPrompts: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
  useProjectSelection: () => ({
    selectedProjectId: "11111111-1111-4111-8111-111111111111",
    selectedProject: { id: "11111111-1111-4111-8111-111111111111", name: "Project One" },
    isLoading: false,
    error: null,
  }),
}));
vi.mock("../../src/lib/api", () => ({ listPrompts }));

import { PromptsPage } from "../../src/routes/prompts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("PromptsPage", () => {
  beforeEach(() => listPrompts.mockReset());
  afterEach(cleanup);

  it("lists the selected project's name, canonical ID, latest version, and time", async () => {
    listPrompts.mockResolvedValue({
      items: [{
        id: "support-agent",
        project_id: PROJECT_ID,
        name: "Support Agent",
        description: null,
        version: 4,
        role: "system",
        source: "Hello",
        model: null,
        settings: {},
        change_summary: "Revise greeting",
        created_by: "admin",
        created_at: "2026-07-15T10:00:00.000Z",
        content_hash: "a".repeat(64),
        diff: null,
      }],
      total: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><PromptsPage /></QueryClientProvider>);

    const row = await screen.findByTestId("prompt-row");
    expect(row).toHaveTextContent("Support Agent");
    expect(row).toHaveTextContent("support-agent");
    expect(row).toHaveTextContent("v4");
    expect(row).toHaveTextContent("2026");
    expect(listPrompts).toHaveBeenCalledWith(PROJECT_ID);
  });
});
