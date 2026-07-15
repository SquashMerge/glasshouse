import { useQuery } from "@tanstack/react-query";
import { useProjectSelection } from "./ProjectProvider";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { getPromptProvenance } from "../lib/api";

export interface PromptProvenance {
  id: string;
  version: number;
  content_hash: string;
}

const PROMPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

export function parsePromptProvenance(metadata: string | undefined): PromptProvenance | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!isRecord(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.attributes) || !isRecord(parsed.prompt_provenance)) return null;
    const provenance = parsed.prompt_provenance;
    if (
      typeof provenance.id !== "string" ||
      !PROMPT_ID.test(provenance.id) ||
      typeof provenance.version !== "number" ||
      !Number.isSafeInteger(provenance.version) ||
      provenance.version < 1 ||
      typeof provenance.content_hash !== "string" ||
      !CONTENT_HASH.test(provenance.content_hash)
    ) return null;
    return { id: provenance.id, version: provenance.version, content_hash: provenance.content_hash };
  } catch {
    return null;
  }
}

export function PromptProvenanceCard({ metadata }: { metadata: string | undefined }) {
  const provenance = parsePromptProvenance(metadata);
  const { selectedProjectId } = useProjectSelection();
  const statusQuery = useQuery({
    queryKey: ["prompt-provenance", selectedProjectId, provenance?.id, provenance?.version, provenance?.content_hash],
    queryFn: () => getPromptProvenance({
      project_id: selectedProjectId!,
      id: provenance!.id,
      version: provenance!.version,
      content_hash: provenance!.content_hash,
    }),
    enabled: Boolean(selectedProjectId && provenance),
  });

  return (
    <Card data-testid="prompt-provenance-card">
      <CardHeader><CardTitle>Prompt provenance</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!provenance && <p className="text-muted-foreground">No prompt provenance was recorded for this generation.</p>}
        {provenance && (
          <dl className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Prompt</dt><dd className="font-mono">{provenance.id}</dd>
            <dt className="text-muted-foreground">Version</dt><dd>v{provenance.version}</dd>
            <dt className="text-muted-foreground">Content hash</dt><dd className="break-all font-mono text-xs">{provenance.content_hash}</dd>
          </dl>
        )}
        {provenance && !selectedProjectId && <p className="text-muted-foreground" data-testid="provenance-no-project">Select a project to check this prompt's status.</p>}
        {provenance && selectedProjectId && statusQuery.isLoading && <p className="text-muted-foreground">Checking prompt status…</p>}
        {provenance && selectedProjectId && statusQuery.isError && <p className="text-destructive" role="alert" aria-live="assertive">{(statusQuery.error as Error).message}</p>}
        {provenance && selectedProjectId && statusQuery.data && (
          <div className="flex items-center gap-2" aria-live="polite">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={statusQuery.data.status === "active" ? "success" : statusQuery.data.status === "deleted" ? "destructive" : "secondary"} data-testid="provenance-status">{statusQuery.data.status}</Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
