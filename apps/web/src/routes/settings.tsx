import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useProjectSelection } from "../components/ProjectProvider";
import {
  createCustomerCredential,
  listCustomerCredentials,
  revokeCustomerCredential,
  type CustomerCredential,
  type CustomerCredentialScope,
  type CustomerCredentialWithSecret,
} from "../lib/api";

const SCOPES: Array<{ value: CustomerCredentialScope; label: string; description: string }> = [
  { value: "prompts:read", label: "Read prompts", description: "List prompts, versions, and prompt content." },
  { value: "prompts:render", label: "Render prompts", description: "Render saved prompts with supplied data." },
  { value: "prompts:write", label: "Write prompts", description: "Create prompts and immutable versions." },
];

export function SettingsPage() {
  const { projects, selectedProjectId, selectProject } = useProjectSelection();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = React.useState("");
  const [scopes, setScopes] = React.useState<CustomerCredentialScope[]>(["prompts:read"]);
  const [expiresAt, setExpiresAt] = React.useState("");
  const [created, setCreated] = React.useState<CustomerCredentialWithSecret | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<CustomerCredential | null>(null);

  const credentialsQuery = useQuery({
    queryKey: ["customer-credentials", selectedProjectId],
    queryFn: () => listCustomerCredentials(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
  });
  const revokeMutation = useMutation({
    mutationFn: revokeCustomerCredential,
    onSuccess: (_, variables) => {
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["customer-credentials", variables.project_id] });
    },
  });

  function toggleScope(scope: CustomerCredentialScope) {
    setScopes((current) => current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope]);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !displayName.trim() || scopes.length === 0) return;
    const expires_at = expiresAt ? new Date(expiresAt).toISOString() : null;
    setIsCreating(true);
    setCreateError(null);
    try {
      const credential = await createCustomerCredential({ project_id: selectedProjectId, display_name: displayName.trim(), scopes, expires_at });
      // The secret intentionally remains component state only, never query-cached or persisted.
      setCreated(credential);
      setDisplayName("");
      setScopes(["prompts:read"]);
      setExpiresAt("");
      await queryClient.invalidateQueries({ queryKey: ["customer-credentials", credential.project_id] });
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Credential creation failed");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="settings-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage project-bound customer API credentials.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Create customer credential</CardTitle>
          <CardDescription>Credentials are opaque bearer secrets. Their project binding and scopes are enforced by the API.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2">
              <label htmlFor="credential-project" className="text-sm font-medium">Project</label>
              <select id="credential-project" value={selectedProjectId ?? ""} onChange={(event) => selectProject(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="credential-project">
                <option value="">Select a project</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="credential-name" className="text-sm font-medium">Name</label>
              <Input id="credential-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={255} placeholder="Production renderer" autoComplete="off" />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Scopes</legend>
              {SCOPES.map((scope) => (
                <label key={scope.value} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm">
                  <input type="checkbox" aria-label={scope.label} checked={scopes.includes(scope.value)} onChange={() => toggleScope(scope.value)} />
                  <span><span className="block font-medium">{scope.label}</span><span className="text-muted-foreground">{scope.description}</span></span>
                </label>
              ))}
            </fieldset>
            <div className="space-y-2">
              <label htmlFor="credential-expiry" className="text-sm font-medium">Expires at (optional)</label>
              <Input id="credential-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
            </div>
            {createError && <p role="alert" className="text-sm text-destructive">{createError}</p>}
            <Button type="submit" disabled={!selectedProjectId || !displayName.trim() || scopes.length === 0 || isCreating} data-testid="create-credential">
              {isCreating ? "Creating…" : "Create credential"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {created && <CreatedSecret credential={created} onDismiss={() => setCreated(null)} />}

      <Card>
        <CardHeader><CardTitle className="text-lg">Customer credentials</CardTitle><CardDescription>Secrets are never shown again after creation.</CardDescription></CardHeader>
        <CardContent>
          {!selectedProjectId && <p className="text-sm text-muted-foreground">Select a project to view its credentials.</p>}
          {credentialsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading credentials…</p>}
          {credentialsQuery.isError && <p role="alert" className="text-sm text-destructive">{(credentialsQuery.error as Error).message}</p>}
          {credentialsQuery.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No customer credentials exist for this project.</p>}
          {credentialsQuery.data?.items.map((credential) => <CredentialRow key={credential.id} credential={credential} onRevoke={() => setRevokeTarget(credential)} />)}
        </CardContent>
      </Card>

      {revokeTarget && <RevokeCredentialDialog credential={revokeTarget} isRevoking={revokeMutation.isPending} error={revokeMutation.isError ? (revokeMutation.error as Error).message : null} onClose={() => setRevokeTarget(null)} onConfirm={() => void revokeMutation.mutate({ project_id: revokeTarget.project_id, id: revokeTarget.id })} />}
    </div>
  );
}

function CreatedSecret({ credential, onDismiss }: { credential: CustomerCredentialWithSecret; onDismiss: () => void }) {
  return (
    <Alert data-testid="credential-secret" aria-live="polite">
      <AlertTitle>Copy this secret now</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>This is the only time the credential secret will be shown. Store it in your secret manager; it cannot be recovered.</p>
        <code className="block break-all rounded bg-muted p-3 text-xs" data-testid="credential-secret-value">{credential.secret}</code>
        <Button type="button" variant="outline" size="sm" onClick={onDismiss}>I stored the secret</Button>
      </AlertDescription>
    </Alert>
  );
}

function CredentialRow({ credential, onRevoke }: { credential: CustomerCredential; onRevoke: () => void }) {
  const status = credential.revoked_at ? "Revoked" : credential.expires_at && new Date(credential.expires_at) <= new Date() ? "Expired" : "Active";
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-4 last:border-0" data-testid="credential-row">
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{credential.display_name} <span className="text-sm font-normal text-muted-foreground">{status}</span></p>
        <p className="font-mono text-xs text-muted-foreground">{credential.prefix}… {credential.fingerprint}</p>
        <p className="text-xs text-muted-foreground">{credential.scopes.join(", ")}{credential.expires_at ? ` · expires ${new Date(credential.expires_at).toLocaleString()}` : ""}</p>
      </div>
      {!credential.revoked_at && <Button type="button" variant="destructive" size="sm" onClick={onRevoke}>Revoke</Button>}
    </div>
  );
}

function RevokeCredentialDialog({ credential, isRevoking, error, onClose, onConfirm }: { credential: CustomerCredential; isRevoking: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="revoke-credential-title" className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="revoke-credential-title" className="text-lg font-semibold">Revoke credential</h2>
        <p className="mt-3 text-sm text-muted-foreground">Revoke <strong>{credential.display_name}</strong>? Requests using this secret will stop working immediately.</p>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-6 flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose} disabled={isRevoking}>Cancel</Button><Button type="button" variant="destructive" onClick={onConfirm} disabled={isRevoking} data-testid="confirm-revoke">{isRevoking ? "Revoking…" : "Revoke credential"}</Button></div>
      </div>
    </div>
  );
}
