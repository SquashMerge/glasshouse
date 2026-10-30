import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { getNewPasswordValidationError } from "../lib/password-policy";

export function AuthCard({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<main className="min-h-screen grid place-items-center bg-background px-4 py-10 text-foreground">
			<div className="w-full max-w-md space-y-6">
				<p className="text-center text-lg font-semibold tracking-tight">
					Glasshouse
				</p>
				<Card>
					<CardHeader className="space-y-2">
						<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
						<CardDescription>{description}</CardDescription>
					</CardHeader>
					<CardContent>{children}</CardContent>
				</Card>
			</div>
		</main>
	);
}

export function FirstPasswordForm({
	setup,
	onComplete,
	onUnavailable,
}: {
	setup: boolean;
	onComplete: () => void;
	onUnavailable?: () => void;
}) {
	const [username, setUsername] = React.useState("");
	const [code, setCode] = React.useState("");
	const [password, setPassword] = React.useState("");
	const [confirmation, setConfirmation] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const errorRef = React.useRef<HTMLParagraphElement>(null);
	React.useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);
	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (pending) return;
		if (password !== confirmation) {
			setError("Passwords must match.");
			return;
		}
		const passwordError = getNewPasswordValidationError(password);
		if (passwordError) {
			setError(passwordError);
			return;
		}
		setPending(true);
		setError(null);
		try {
			const response = await fetch(
				setup ? "/v1/auth/setup" : "/v1/auth/invitations/accept",
				{
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						setup
							? { username, password, token: code }
							: { password, token: code },
					),
				},
			);
			if (response.ok) {
				onComplete();
				return;
			}
			setError(
				setup
					? "Setup could not be completed. The secret may be invalid, expired or temporarily limited, or setup may already be closed. Ask your operator."
					: "Enrollment could not be completed. The code may be invalid, expired, revoked or already used, or the account disabled. Ask your Admin for a new code; repeated attempts may be temporarily limited.",
			);
			if (setup) onUnavailable?.();
		} catch {
			setError("Connection unavailable. Check your connection and retry.");
		} finally {
			setCode("");
			setPassword("");
			setConfirmation("");
			setPending(false);
		}
	}
	return (
		<form className="space-y-5" onSubmit={submit} aria-busy={pending}>
			{setup && (
				<div className="space-y-2">
					<Label htmlFor="setup-username">Username</Label>
					<Input
						id="setup-username"
						autoComplete="username"
						required
						minLength={3}
						maxLength={64}
						pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}"
						value={username}
						disabled={pending}
						onChange={(event) => setUsername(event.target.value)}
						aria-describedby="username-help"
					/>
					<p id="username-help" className="text-xs text-muted-foreground">
						3–64 ASCII characters. Start with a letter or number; then letters,
						numbers, dots, underscores or hyphens. Case is normalized.
					</p>
				</div>
			)}
			<div className="space-y-2">
				<Label htmlFor="enrollment-code">
					{setup ? "Setup secret" : "Enrollment code"}
				</Label>
				<Input
					id="enrollment-code"
					type="password"
					autoComplete="off"
					spellCheck={false}
					required
					minLength={43}
					maxLength={43}
					value={code}
					onChange={(event) => setCode(event.target.value)}
					disabled={pending}
					aria-describedby="code-help"
				/>
				<p id="code-help" className="text-xs text-muted-foreground">
					{setup
						? "Provided by your deployment operator. Valid for 24 hours and one setup."
						: "Provided privately by your Admin. Valid for seven days and one password setting."}{" "}
					Paste the code here, never into a URL.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="new-password">New password</Label>
				<Input
					id="new-password"
					type="password"
					autoComplete="new-password"
					required
					maxLength={1024}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					disabled={pending}
					aria-describedby="new-password-help"
				/>
				<p id="new-password-help" className="text-xs text-muted-foreground">
					Use at least 12 characters. Longer, unique passphrases are easier to
					remember. Don’t reuse a password from another site.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="confirm-password">Confirm password</Label>
				<Input
					id="confirm-password"
					type="password"
					autoComplete="new-password"
					required
					maxLength={1024}
					value={confirmation}
					onChange={(event) => setConfirmation(event.target.value)}
					disabled={pending}
				/>
			</div>
			{error && (
				<p
					className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
					role="alert"
					tabIndex={-1}
					ref={errorRef}
				>
					{error}
				</p>
			)}
			<Button type="submit" className="w-full" disabled={pending}>
				{pending ? "Saving…" : setup ? "Create first Admin" : "Set password"}
			</Button>
			<Link
				to="/login"
				className="block text-center text-sm underline underline-offset-4"
			>
				Back to sign in
			</Link>
		</form>
	);
}
