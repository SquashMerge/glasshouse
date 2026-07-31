import * as React from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { authHeader, setCredentials } from "../lib/auth";
import { clearWorkspaceSession } from "../components/ProjectProvider";

export function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const location = useLocation();
	const [username, setUsername] = React.useState("");
	const [password, setPassword] = React.useState("");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		const creds = { username, password };
		try {
			const res = await fetch("/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", ...authHeader(creds) },
				body: "{}",
			});
			if (res.status === 200) {
				clearWorkspaceSession(queryClient);
				setCredentials(username, password);
				const redirect = new URLSearchParams(location.searchStr).get(
					"redirect",
				);
				navigate({ to: safeRedirect(redirect) });
			} else if (res.status === 401) {
				setError("Invalid credentials");
			} else {
				setError(`Login failed (status ${res.status})`);
			}
		} catch (err) {
			setError(`Login failed: ${(err as Error).message}`);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-background px-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>Sign in</CardTitle>
					<CardDescription>
						Use the Basic Auth credentials configured via{" "}
						<code className="text-xs">UI_USERNAME</code> /
						<code className="text-xs">UI_PASSWORD</code>.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={onSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="username">Username</Label>
							<Input
								id="username"
								name="username"
								autoComplete="username"
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
						</div>
						{error && (
							<Alert variant="destructive">
								<AlertTitle>Login failed</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<Button type="submit" disabled={submitting} className="w-full">
							{submitting ? "Signing in…" : "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}

export function safeRedirect(value: string | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//")) {
		return "/";
	}

	// A stale auth redirect can itself point at /login, which would send a
	// successful login back into the same redirect chain forever.
	if (new URL(value, "http://astraea.local").pathname === "/login") {
		return "/";
	}

	return value;
}
