import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ApiError, changeOwnPassword } from "../lib/api";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
	PASSWORD_REQUIREMENTS,
	validNewPassword,
} from "../lib/password-policy";
import { expireAuthSession } from "../lib/auth";

export function PasswordChangePage() {
	const [currentPassword, setCurrentPassword] = React.useState("");
	const [newPassword, setNewPassword] = React.useState("");
	const [confirmation, setConfirmation] = React.useState("");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const errorRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		if (newPassword !== confirmation) {
			setError("New passwords do not match.");
			return;
		}
		if (!validNewPassword(newPassword)) {
			setError(PASSWORD_REQUIREMENTS);
			return;
		}

		setSubmitting(true);
		setError(null);
		try {
			await changeOwnPassword(currentPassword, newPassword);
			setCurrentPassword("");
			setNewPassword("");
			setConfirmation("");
			expireAuthSession();
			window.location.assign("/login?passwordChanged=1");
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 422) {
				setError("The current password is incorrect. Check it and try again.");
			} else if (cause instanceof ApiError && cause.status === 429) {
				setError("Too many attempts. Wait before trying again.");
			} else {
				setError("Password change could not be completed. Please retry.");
			}
			setCurrentPassword("");
			setNewPassword("");
			setConfirmation("");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Card className="w-full max-w-lg">
			<CardHeader>
				<h1 className="text-2xl font-semibold tracking-tight">
					Change password
				</h1>
				<CardDescription>
					Enter your current password and choose a new one. You will be signed
					out on this and other sessions after the change.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={onSubmit} className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="current-password">Current password</Label>
						<Input
							id="current-password"
							name="current_password"
							type="password"
							autoComplete="current-password"
							value={currentPassword}
							onChange={(event) => setCurrentPassword(event.target.value)}
							required
							disabled={submitting}
							maxLength={1024}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="new-password">New password</Label>
						<Input
							id="new-password"
							name="new_password"
							type="password"
							autoComplete="new-password"
							value={newPassword}
							onChange={(event) => setNewPassword(event.target.value)}
							required
							disabled={submitting}
							maxLength={1024}
							aria-describedby="password-help"
						/>
						<p id="password-help" className="text-xs text-muted-foreground">
							{PASSWORD_REQUIREMENTS}
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="confirm-password">Confirm new password</Label>
						<Input
							id="confirm-password"
							name="confirm_password"
							type="password"
							autoComplete="new-password"
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
							required
							disabled={submitting}
							maxLength={1024}
						/>
					</div>
					{error && (
						<Alert variant="destructive" tabIndex={-1} ref={errorRef}>
							<AlertTitle>Password change failed</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
						<Link
							to="/"
							aria-disabled={submitting || undefined}
							className={cn(
								buttonVariants({ variant: "outline" }),
								submitting && "pointer-events-none opacity-50",
							)}
						>
							Cancel
						</Link>
						<Button type="submit" disabled={submitting}>
							{submitting ? "Changing password…" : "Change password"}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
