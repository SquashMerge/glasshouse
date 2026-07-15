import * as React from "react";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useProjectSelection } from "../components/ProjectProvider";
import { deletePrompt, getPrompt, listPromptVersions, type Prompt } from "../lib/api";
import { formatDate, PageMessage } from "./prompts";

export function PromptDetailPage() {
  const { slug } = useParams({ from: "/protected/prompts/$slug" });
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedProjectId, selectedProject } = useProjectSelection();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const deleteTriggerRef = React.useRef<HTMLButtonElement>(null);
  const selectedVersion = queryVersion(location.searchStr, "version");

  const currentQuery = useQuery({
    queryKey: ["prompt", selectedProjectId, slug, "current"],
    queryFn: () => getPrompt({ project_id: selectedProjectId!, slug }),
    enabled: Boolean(selectedProjectId),
  });
  const selectedQuery = useQuery({
    queryKey: ["prompt", selectedProjectId, slug, selectedVersion],
    queryFn: () => getPrompt({ project_id: selectedProjectId!, slug, version: selectedVersion! }),
    enabled: Boolean(selectedProjectId && selectedVersion),
  });
  const historyQuery = useQuery({
    queryKey: ["prompt-versions", selectedProjectId, slug],
    queryFn: () => listPromptVersions({ project_id: selectedProjectId!, slug }),
    enabled: Boolean(selectedProjectId),
  });

  const deleteMutation = useMutation({
    mutationFn: (confirmation: string) => {
      if (!selectedProjectId) throw new Error("Select a project before deleting a prompt.");
      return deletePrompt({ project_id: selectedProjectId, slug, confirmation });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["prompts", selectedProjectId] });
      await navigate({ to: "/prompts" });
    },
  });

  if (!selectedProjectId || !selectedProject) {
    return <PageMessage title="Prompt">Select a project to view this prompt.</PageMessage>;
  }

  if (currentQuery.isLoading || (selectedVersion && selectedQuery.isLoading) || historyQuery.isLoading) {
    return <PageMessage title="Prompt">Loading prompt…</PageMessage>;
  }

  const error = currentQuery.error ?? selectedQuery.error ?? historyQuery.error;
  if (error) {
    return (
      <Alert variant="destructive" aria-live="assertive">
        <AlertTitle>Prompt could not be loaded</AlertTitle>
        <AlertDescription>{error instanceof Error ? error.message : "Prompt could not be loaded."}</AlertDescription>
      </Alert>
    );
  }

  const prompt = selectedVersion ? selectedQuery.data : currentQuery.data;
  if (!prompt || !currentQuery.data) return <PageMessage title="Prompt">Prompt could not be loaded.</PageMessage>;

  return (
    <div className="space-y-6" data-testid="prompt-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{prompt.name}</h1>
          <p className="font-mono text-sm text-muted-foreground">{prompt.id}@{prompt.version}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/prompts/$slug/edit" params={{ slug: prompt.id }} search={{ from: prompt.version }} className={buttonVariants({ variant: "outline" })}>New version</Link>
          <Button ref={deleteTriggerRef} variant="destructive" onClick={() => { deleteMutation.reset(); setDeleteOpen(true); }}>Delete</Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(14rem,0.38fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader><CardTitle>Version history</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-2" aria-label="Prompt versions">
              {historyQuery.data?.items.map((version) => (
                <li key={version.version}>
                  <button
                    type="button"
                    onClick={() => navigate({ to: "/prompts/$slug", params: { slug }, search: { version: version.version } })}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${version.version === prompt.version ? "border-primary bg-muted" : "border-border hover:bg-muted/60"}`}
                    aria-current={version.version === prompt.version ? "page" : undefined}
                    data-testid="prompt-version"
                    data-version={version.version}
                  >
                    <span className="flex items-center justify-between gap-2"><span className="font-medium">v{version.version}</span><time className="text-xs text-muted-foreground" dateTime={version.created_at}>{formatDate(version.created_at)}</time></span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{version.change_summary}</span>
                  </button>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <PromptVersionDetails prompt={prompt} />
          <Card>
            <CardHeader><CardTitle>Current / previous diff</CardTitle></CardHeader>
            <CardContent>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs" data-testid="prompt-diff">{prompt.diff ?? "No previous version is available for comparison."}</pre>
            </CardContent>
          </Card>
        </div>
      </div>

      {deleteOpen && (
        <DeletePromptDialog
          slug={prompt.id}
          isDeleting={deleteMutation.isPending}
          error={deleteMutation.error instanceof Error ? deleteMutation.error.message : null}
          onClose={() => {
            if (deleteMutation.isPending) return;
            setDeleteOpen(false);
            deleteTriggerRef.current?.focus();
          }}
          onDelete={(confirmation) => deleteMutation.mutate(confirmation)}
        />
      )}
    </div>
  );
}

function PromptVersionDetails({ prompt }: { prompt: Prompt }) {
  return (
    <Card>
      <CardHeader><CardTitle>Version v{prompt.version}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Content hash</dt><dd className="break-all font-mono text-xs">{prompt.content_hash}</dd></div>
          <div><dt className="text-muted-foreground">Created by</dt><dd>{prompt.created_by}</dd></div>
          <div><dt className="text-muted-foreground">Created</dt><dd><time dateTime={prompt.created_at}>{formatDate(prompt.created_at)}</time></dd></div>
          <div><dt className="text-muted-foreground">Model</dt><dd>{prompt.model ?? "—"}</dd></div>
          <div><dt className="text-muted-foreground">Change summary</dt><dd>{prompt.change_summary}</dd></div>
        </dl>
        <div className="space-y-2"><h2 className="text-sm font-medium">Settings</h2><pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(prompt.settings, null, 2)}</pre></div>
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Messages</h2>
          {prompt.messages.map((message) => (
            <div key={message.role} className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{message.role}</p>
              <pre className="overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm" data-testid={`prompt-message-${message.role}`}>{message.content}</pre>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DeletePromptDialog({
  slug,
  isDeleting,
  error,
  onClose,
  onDelete,
}: {
  slug: string;
  isDeleting: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: (confirmation: string) => void;
}) {
  const [confirmation, setConfirmation] = React.useState("");
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isDeleting) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isDeleting, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4" onMouseDown={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-prompt-title" className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="delete-prompt-title" className="text-lg font-semibold">Delete prompt</h2>
        <p className="mt-3 text-sm text-muted-foreground">This permanently deletes the prompt and its version history. Existing trace references remain, but their prompt provenance will report deletion.</p>
        <div className="mt-4 space-y-2">
          <label htmlFor="delete-confirmation" className="text-sm font-medium">Type <span className="font-mono">{slug}</span> to confirm</label>
          <Input ref={inputRef} id="delete-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={isDeleting} autoComplete="off" data-testid="delete-confirmation" />
        </div>
        {error && <p className="mt-3 text-sm text-destructive" role="alert" aria-live="assertive">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={isDeleting}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => onDelete(confirmation)} disabled={confirmation !== slug || isDeleting} data-testid="confirm-delete">{isDeleting ? "Deleting…" : "Delete prompt"}</Button>
        </div>
      </div>
    </div>
  );
}

function queryVersion(search: string, key: string): number | undefined {
  const value = new URLSearchParams(search).get(key);
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : undefined;
}
