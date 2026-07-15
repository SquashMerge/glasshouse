import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useProjectSelection } from "../components/ProjectProvider";
import { PageMessage } from "./prompts";
import {
  createPrompt,
  createPromptVersion,
  renderPrompt,
  type JsonObject,
  type Prompt,
  type PromptRenderResponse,
  type PromptRole,
} from "../lib/api";

const TEXTAREA_CLASS = "min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

interface PromptComposerProps {
  projectId: string | null;
  existing?: Prompt;
  current?: Prompt;
  onSaved: (prompt: Prompt | { id: string; version: number }) => void;
}

export function PromptComposer({ projectId, existing, current, onSaved }: PromptComposerProps) {
  const isVersion = Boolean(existing && current);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [role, setRole] = React.useState<PromptRole>("system");
  const [source, setSource] = React.useState("");
  const [model, setModel] = React.useState("");
  const [settingsText, setSettingsText] = React.useState("{}");
  const [changeSummary, setChangeSummary] = React.useState("");
  const [variablesText, setVariablesText] = React.useState("{}");
  const [formError, setFormError] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const existingKey = existing ? `${existing.id}:${existing.version}` : null;
  React.useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? "");
    setRole(existing.role);
    setSource(existing.source);
    setModel(existing.model ?? "");
    setSettingsText(prettyJson(existing.settings));
  }, [existingKey]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("Select a project before saving a prompt.");
      const settings = parseObject(settingsText, "Settings");
      if (isVersion) {
        if (!existing || !current) throw new Error("The selected prompt version is unavailable.");
        const summary = changeSummary.trim();
        if (!summary) throw new Error("A change summary is required for a new version.");
        return createPromptVersion({
          project_id: projectId,
          slug: existing.id,
          base_version: current.version,
          source,
          model: model || null,
          settings,
          change_summary: summary,
        });
      }
      if (!name.trim()) throw new Error("Prompt name is required.");
      return createPrompt({
        project_id: projectId,
        name: name.trim(),
        description: description.trim() || null,
        role,
        source,
        model: model || null,
        settings,
      });
    },
    onSuccess: (prompt) => onSaved(prompt),
    onError: (error) => setFormError(error instanceof Error ? error.message : "Prompt could not be saved."),
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!projectId || !existing) throw new Error("Save the prompt before requesting a server preview.");
      const data = parseObject(variablesText, "Variables");
      return renderPrompt({ project_id: projectId, slug: existing.id, version: existing.version, data });
    },
    onMutate: () => {
      setPreviewError(null);
    },
    onError: (error) => setPreviewError(error instanceof Error ? error.message : "Preview could not be rendered."),
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    saveMutation.mutate();
  }

  return (
    <form className="space-y-6" onSubmit={submit} data-testid="prompt-composer">
      {formError && (
        <Alert variant="destructive" aria-live="assertive">
          <AlertTitle>Prompt could not be saved</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.55fr)]">
        <Card>
          <CardHeader><CardTitle>{isVersion ? `New version for ${existing?.id}` : "New prompt"}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="prompt-name">Name</Label>
                <Input id="prompt-name" value={name} onChange={(event) => setName(event.target.value)} disabled={isVersion || saveMutation.isPending} required={!isVersion} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prompt-role">Role</Label>
                <select
                  id="prompt-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as PromptRole)}
                  disabled={isVersion || saveMutation.isPending}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="system">system</option>
                  <option value="user">user</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt-description">Description <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="prompt-description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={isVersion || saveMutation.isPending} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt-source">Source</Label>
              <textarea id="prompt-source" className={TEXTAREA_CLASS} value={source} onChange={(event) => setSource(event.target.value)} disabled={saveMutation.isPending} aria-describedby="prompt-source-hint" />
              <p id="prompt-source-hint" className="text-xs text-muted-foreground">Mustache variables are rendered only by the server preview.</p>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="prompt-model">Model <span className="text-muted-foreground">(optional)</span></Label>
                <Input id="prompt-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={saveMutation.isPending} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prompt-settings">Settings JSON</Label>
                <textarea id="prompt-settings" className={TEXTAREA_CLASS} value={settingsText} onChange={(event) => setSettingsText(event.target.value)} disabled={saveMutation.isPending} />
              </div>
              {isVersion && (
                <div className="space-y-2">
                  <Label htmlFor="prompt-change-summary">Change summary</Label>
                  <Input id="prompt-change-summary" value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} disabled={saveMutation.isPending} required />
                </div>
              )}
              <Button type="submit" disabled={!projectId || saveMutation.isPending} data-testid="save-prompt">
                {saveMutation.isPending ? "Saving…" : isVersion ? "Create version" : "Create prompt"}
              </Button>
            </CardContent>
          </Card>

          <ServerPreview
            enabled={Boolean(projectId && existing)}
            variablesText={variablesText}
            onVariablesChange={setVariablesText}
            onPreview={() => previewMutation.mutate()}
            isPending={previewMutation.isPending}
            error={previewError}
            preview={previewMutation.data}
            version={existing?.version}
          />
        </div>
      </div>
    </form>
  );
}

function ServerPreview({
  enabled,
  variablesText,
  onVariablesChange,
  onPreview,
  isPending,
  error,
  preview,
  version,
}: {
  enabled: boolean;
  variablesText: string;
  onVariablesChange: (value: string) => void;
  onPreview: () => void;
  isPending: boolean;
  error: string | null;
  preview: PromptRenderResponse | undefined;
  version: number | undefined;
}) {
  return (
    <Card data-testid="server-preview">
      <CardHeader><CardTitle>Server preview</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {enabled ? (
          <>
            <p className="text-xs text-muted-foreground">Previewing saved v{version}. Save a new draft before previewing it.</p>
            <div className="space-y-2">
              <Label htmlFor="prompt-variables">Variables JSON</Label>
              <textarea id="prompt-variables" className={TEXTAREA_CLASS} value={variablesText} onChange={(event) => onVariablesChange(event.target.value)} disabled={isPending} />
            </div>
            <Button type="button" variant="outline" onClick={onPreview} disabled={isPending} data-testid="preview-prompt">{isPending ? "Rendering…" : "Preview"}</Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Save the prompt to request a server preview.</p>
        )}
        {error && <p className="text-sm text-destructive" role="alert" aria-live="assertive">{error}</p>}
        {preview && (
          <div className="space-y-3" aria-live="polite">
            {preview.warnings.length > 0 && (
              <ul className="rounded-md border border-destructive/50 p-3 text-sm text-destructive" data-testid="preview-warnings">
                {preview.warnings.map((warning) => <li key={warning.path}>Missing variable: {warning.path}</li>)}
              </ul>
            )}
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm" data-testid="preview-output">{preview.output}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function NewPromptPage() {
  const { selectedProjectId, selectedProject } = useProjectSelection();
  const navigate = useNavigate();

  if (!selectedProjectId || !selectedProject) {
    return <PageMessage title="New prompt">Select a project before creating a prompt.</PageMessage>;
  }

  return (
    <PromptComposer
      projectId={selectedProjectId}
      onSaved={(prompt) => {
        navigate({ to: "/prompts/$slug", params: { slug: prompt.id } });
      }}
    />
  );
}

function parseObject(value: string, label: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a JSON object.`) throw error;
    throw new Error(`${label} must be valid JSON.`);
  }
}

function prettyJson(value: JsonObject): string {
  return JSON.stringify(value, null, 2);
}
