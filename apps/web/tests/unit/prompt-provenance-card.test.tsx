import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const selection = vi.hoisted(() => ({ projectId: null as string | null }));
const { getPromptProvenance } = vi.hoisted(() => ({ getPromptProvenance: vi.fn() }));

vi.mock("../../src/components/ProjectProvider", () => ({
  useProjectSelection: () => ({ selectedProjectId: selection.projectId }),
}));
vi.mock("../../src/lib/api", () => ({ getPromptProvenance }));

import { PromptProvenanceCard } from "../../src/components/PromptProvenanceCard";
import type { PromptProvenance } from "../../src/lib/api";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const provenance = { id: "support-agent", version: 7, content_hash: HASH };

function renderCard(value: PromptProvenance | null = provenance) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PromptProvenanceCard provenance={value} /></QueryClientProvider>);
}

describe("PromptProvenanceCard", () => {
  beforeEach(() => {
    selection.projectId = null;
    getPromptProvenance.mockReset();
  });

  afterEach(cleanup);

  it("does not request a status without a selected project", async () => {
    renderCard();

    await screen.findByTestId("provenance-no-project");
    expect(screen.getByText("support-agent")).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
    expect(getPromptProvenance).not.toHaveBeenCalled();
  });

  it.each(["active", "deleted", "unknown"] as const)("renders the server's %s provenance status", async (status) => {
    selection.projectId = PROJECT_ID;
    getPromptProvenance.mockResolvedValue({ status });
    renderCard();

    await waitFor(() => expect(screen.getByTestId("provenance-status")).toHaveTextContent(status));
    expect(getPromptProvenance).toHaveBeenCalledWith({ project_id: PROJECT_ID, id: "support-agent", version: 7, content_hash: HASH });
  });

  it("renders an explanatory state when the typed provenance tuple is null", () => {
    renderCard(null);

    expect(screen.getByText("No prompt provenance was recorded for this generation.")).toBeInTheDocument();
    expect(getPromptProvenance).not.toHaveBeenCalled();
  });
});
