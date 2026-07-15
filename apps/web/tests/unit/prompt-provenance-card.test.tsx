import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const selection = vi.hoisted(() => ({ projectId: null as string | null }));
const { getPromptProvenance } = vi.hoisted(() => ({ getPromptProvenance: vi.fn() }));

vi.mock("../../src/components/ProjectProvider", () => ({
  useProjectSelection: () => ({ selectedProjectId: selection.projectId }),
}));
vi.mock("../../src/lib/api", () => ({ getPromptProvenance }));

import { parsePromptProvenance, PromptProvenanceCard } from "../../src/components/PromptProvenanceCard";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const metadata = JSON.stringify({
  schema_version: 1,
  attributes: [{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } }],
  prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH },
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PromptProvenanceCard metadata={metadata} /></QueryClientProvider>);
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

  it("accepts only the typed metadata tuple and never exposes arbitrary prompt attributes", () => {
    expect(parsePromptProvenance(JSON.stringify({
      schema_version: 1,
      attributes: [{ key: "astraea.prompt.id", value: { stringValue: "other" } }],
    }))).toBeNull();
    expect(parsePromptProvenance(JSON.stringify({
      schema_version: 1,
      attributes: [],
      prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH.toUpperCase(), source: "secret source" },
    }))).toBeNull();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PromptProvenanceCard metadata={JSON.stringify({ schema_version: 1, attributes: [], prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH, source: "secret source" } })} /></QueryClientProvider>);
    expect(screen.queryByText("secret source")).not.toBeInTheDocument();
  });
});
