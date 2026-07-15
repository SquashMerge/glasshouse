import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useProjectSelection } from "../components/ProjectProvider";
import { getPrompt } from "../lib/api";
import { PageMessage } from "./prompts";
import { PromptComposer } from "./prompts-new";

export function EditPromptPage() {
  const { slug } = useParams({ from: "/protected/prompts/$slug/edit" });
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedProjectId, selectedProject } = useProjectSelection();
  const fromVersion = queryVersion(location.searchStr, "from");

  const currentQuery = useQuery({
    queryKey: ["prompt", selectedProjectId, slug, "current"],
    queryFn: () => getPrompt({ project_id: selectedProjectId!, slug }),
    enabled: Boolean(selectedProjectId),
  });
  const selectedQuery = useQuery({
    queryKey: ["prompt", selectedProjectId, slug, fromVersion],
    queryFn: () => getPrompt({ project_id: selectedProjectId!, slug, version: fromVersion! }),
    enabled: Boolean(selectedProjectId && fromVersion),
  });

  if (!selectedProjectId || !selectedProject) {
    return <PageMessage title="New prompt version">Select a project before creating a prompt version.</PageMessage>;
  }

  if (currentQuery.isLoading || (fromVersion && selectedQuery.isLoading)) {
    return <PageMessage title="New prompt version">Loading prompt…</PageMessage>;
  }

  const error = currentQuery.error ?? selectedQuery.error;
  if (error || !currentQuery.data || (fromVersion && !selectedQuery.data)) {
    return <PageMessage title="New prompt version">{error instanceof Error ? error.message : "Prompt could not be loaded."}</PageMessage>;
  }

  const selected = fromVersion ? selectedQuery.data! : currentQuery.data;
  return (
    <PromptComposer
      projectId={selectedProjectId}
      existing={selected}
      current={currentQuery.data}
      onSaved={(prompt) => {
        navigate({ to: "/prompts/$slug", params: { slug: prompt.id }, search: { version: prompt.version } });
      }}
    />
  );
}

function queryVersion(search: string, key: string): number | undefined {
  const value = new URLSearchParams(search).get(key);
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : undefined;
}
