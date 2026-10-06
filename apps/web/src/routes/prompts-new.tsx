import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useProjectSelection } from "../components/ProjectProvider";
import { PageMessage } from "./prompts";
import {
	createPrompt,
	createPromptVersion,
	ApiError,
	previewPrompt,
	type JsonObject,
	type Prompt,
	type PromptMessage,
	type PromptPreviewResponse,
} from "../lib/api";

const TEXTAREA_CLASS =
	"min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

interface PromptComposerProps {
	projectId: string | null;
	existing?: Prompt;
	current?: Prompt;
	onSaved: (prompt: Prompt | { id: string; version: number }) => void;
}

export function PromptComposer({
	projectId,
	existing,
	current,
	onSaved,
}: PromptComposerProps) {
	const isVersion = Boolean(existing && current);
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [systemSource, setSystemSource] = React.useState("");
	const [userSource, setUserSource] = React.useState("");
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
		setSystemSource(messageContent(existing.messages, "system"));
		setUserSource(messageContent(existing.messages, "user"));
		setModel(existing.model ?? "");
		setSettingsText(prettyJson(existing.settings));
	}, [existingKey]);

	const saveMutation = useMutation({
		mutationFn: async () => {
			if (!projectId)
				throw new Error("Select a project before saving a prompt.");
			const settings = parseObject(settingsText, "Settings");
			const messages = promptMessages(systemSource, userSource);
			if (isVersion) {
				if (!existing || !current)
					throw new Error("The selected prompt version is unavailable.");
				const summary = changeSummary.trim();
				if (!summary)
					throw new Error("A change summary is required for a new version.");
				return createPromptVersion({
					project_id: projectId,
					slug: existing.id,
					base_version: current.version,
					messages,
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
				messages,
				model: model || null,
				settings,
			});
		},
		onSuccess: (prompt) => onSaved(prompt),
		onError: (error) =>
			setFormError(
				error instanceof Error ? error.message : "Prompt could not be saved.",
			),
	});

	const previewMutation = useMutation({
		mutationFn: async () => {
			if (!projectId)
				throw new Error("Select a project before previewing a prompt.");
			const data = parseObject(variablesText, "Variables");
			return previewPrompt({
				project_id: projectId,
				messages: promptMessages(systemSource, userSource),
				data,
			});
		},
		onMutate: () => {
			setPreviewError(null);
		},
		onError: (error) => setPreviewError(previewErrorMessage(error)),
	});

	function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setFormError(null);
		saveMutation.mutate();
	}

	function changeSource(
		setSource: React.Dispatch<React.SetStateAction<string>>,
		value: string,
	) {
		setSource(value);
		previewMutation.reset();
		setPreviewError(null);
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
					<CardHeader>
						<CardTitle>
							{isVersion ? `New version for ${existing?.id}` : "New prompt"}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="prompt-name">Name</Label>
								<Input
									id="prompt-name"
									value={name}
									onChange={(event) => setName(event.target.value)}
									disabled={isVersion || saveMutation.isPending}
									required={!isVersion}
								/>
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor="prompt-description">
								Description{" "}
								<span className="text-muted-foreground">(optional)</span>
							</Label>
							<Input
								id="prompt-description"
								value={description}
								onChange={(event) => setDescription(event.target.value)}
								disabled={isVersion || saveMutation.isPending}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="prompt-system-source">
								System prompt{" "}
								<span className="text-muted-foreground">(optional)</span>
							</Label>
							<textarea
								id="prompt-system-source"
								className={TEXTAREA_CLASS}
								value={systemSource}
								onChange={(event) =>
									changeSource(setSystemSource, event.target.value)
								}
								disabled={saveMutation.isPending}
								aria-describedby="prompt-source-hint"
							/>
							<p
								id="prompt-source-hint"
								className="text-xs text-muted-foreground"
							>
								System and user messages are versioned together. Mustache
								variables are rendered only by the server preview.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="prompt-user-source">
								User prompt{" "}
								<span className="text-muted-foreground">(optional)</span>
							</Label>
							<textarea
								id="prompt-user-source"
								className={TEXTAREA_CLASS}
								value={userSource}
								onChange={(event) =>
									changeSource(setUserSource, event.target.value)
								}
								disabled={saveMutation.isPending}
							/>
						</div>
					</CardContent>
				</Card>

				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>Settings</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="prompt-model">
									Model{" "}
									<span className="text-muted-foreground">(optional)</span>
								</Label>
								<Input
									id="prompt-model"
									value={model}
									onChange={(event) => setModel(event.target.value)}
									disabled={saveMutation.isPending}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="prompt-settings">Settings JSON</Label>
								<textarea
									id="prompt-settings"
									className={TEXTAREA_CLASS}
									value={settingsText}
									onChange={(event) => setSettingsText(event.target.value)}
									disabled={saveMutation.isPending}
								/>
							</div>
							{isVersion && (
								<div className="space-y-2">
									<Label htmlFor="prompt-change-summary">Change summary</Label>
									<Input
										id="prompt-change-summary"
										value={changeSummary}
										onChange={(event) => setChangeSummary(event.target.value)}
										disabled={saveMutation.isPending}
										required
									/>
								</div>
							)}
							<Button
								type="submit"
								disabled={!projectId || saveMutation.isPending}
								data-testid="save-prompt"
							>
								{saveMutation.isPending
									? "Saving…"
									: isVersion
										? "Create version"
										: "Create prompt"}
							</Button>
						</CardContent>
					</Card>

					<ServerPreview
						variablesText={variablesText}
						onVariablesChange={(value) => {
							setVariablesText(value);
							previewMutation.reset();
							setPreviewError(null);
						}}
						onPreview={() => previewMutation.mutate()}
						isPending={previewMutation.isPending}
						error={previewError}
						preview={previewMutation.data}
					/>
				</div>
			</div>
		</form>
	);
}

function ServerPreview({
	variablesText,
	onVariablesChange,
	onPreview,
	isPending,
	error,
	preview,
}: {
	variablesText: string;
	onVariablesChange: (value: string) => void;
	onPreview: () => void;
	isPending: boolean;
	error: string | null;
	preview: PromptPreviewResponse | undefined;
}) {
	return (
		<Card data-testid="server-preview">
			<CardHeader>
				<CardTitle>Server preview</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-xs text-muted-foreground">
					Preview the current unsaved draft with JSON variables.
				</p>
				<div className="space-y-2">
					<Label htmlFor="prompt-variables">Variables JSON</Label>
					<textarea
						id="prompt-variables"
						className={TEXTAREA_CLASS}
						value={variablesText}
						onChange={(event) => onVariablesChange(event.target.value)}
						disabled={isPending}
					/>
				</div>
				<Button
					type="button"
					variant="outline"
					onClick={onPreview}
					disabled={isPending}
					data-testid="preview-prompt"
				>
					{isPending ? "Rendering…" : "Preview"}
				</Button>
				{error && (
					<p
						className="text-sm text-destructive"
						role="alert"
						aria-live="assertive"
					>
						{error}
					</p>
				)}
				{preview && (
					<div className="space-y-3" aria-live="polite">
						{preview.warnings.length > 0 && (
							<ul
								className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
								data-testid="preview-warnings"
							>
								{preview.warnings.map((warning) => (
									<li key={`${warning.role}:${warning.path}`}>
										{warning.role}: missing variable {warning.path}
									</li>
								))}
							</ul>
						)}
						{preview.messages.map((message) => (
							<div key={message.role} className="space-y-1">
								<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									{message.role}
								</p>
								<pre
									className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm"
									data-testid={`preview-output-${message.role}`}
								>
									{message.content}
								</pre>
							</div>
						))}
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
		return (
			<PageMessage title="New prompt">
				Select a project before creating a prompt.
			</PageMessage>
		);
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
		if (
			error instanceof Error &&
			error.message === `${label} must be a JSON object.`
		)
			throw error;
		throw new Error(`${label} must be valid JSON.`);
	}
}

function previewErrorMessage(error: unknown): string {
	if (
		error instanceof Error &&
		(error.message === "Select a project before previewing a prompt." ||
			error.message === "Enter a system or user prompt." ||
			error.message.endsWith("must be valid JSON.") ||
			error.message.endsWith("must be a JSON object."))
	)
		return error.message;
	if (error instanceof ApiError && error.status === 400) {
		if (error.message === "Request validation failed")
			return "Preview request was rejected. Check your prompt and variables JSON, then try again.";
		return error.message;
	}
	return "Preview service is unavailable. Your draft is still available; try again.";
}

function prettyJson(value: JsonObject): string {
	return JSON.stringify(value, null, 2);
}

function promptMessages(system: string, user: string): PromptMessage[] {
	const messages: PromptMessage[] = [];
	if (system) messages.push({ role: "system", content: system });
	if (user) messages.push({ role: "user", content: user });
	if (messages.length === 0) throw new Error("Enter a system or user prompt.");
	return messages;
}

function messageContent(
	messages: PromptMessage[],
	role: PromptMessage["role"],
): string {
	return messages.find((message) => message.role === role)?.content ?? "";
}
