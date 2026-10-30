import * as React from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
	clearAuthSession,
	invalidateOtherAuthTabs,
	readAuthSession,
	sessionNeedsSignIn,
} from "../lib/auth";
import { clearWorkspaceSession } from "../components/ProjectProvider";

export function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const location = useLocation();
	const [username, setUsername] = React.useState("");
	const [password, setPassword] = React.useState("");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const errorRef = React.useRef<HTMLDivElement>(null);
	const passwordChanged =
		new URLSearchParams(location.searchStr).get("passwordChanged") === "1";
	React.useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);
	React.useEffect(() => {
		let active = true;
		void fetch("/v1/auth/setup", { cache: "no-store" })
			.then(async (response) => {
				if (response.ok && (await response.json()).available && active)
					void navigate({ to: "/setup" });
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [navigate]);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		setError(null);
		clearAuthSession();
		try {
			const res = await fetch("/v1/auth/login", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			if (res.status === 200) {
				setPassword("");
				clearWorkspaceSession(queryClient);
				clearAuthSession();
				if (!(await readAuthSession())) throw new Error("Session unavailable");
				invalidateOtherAuthTabs();
				const redirect = new URLSearchParams(location.searchStr).get(
					"redirect",
				);
				navigate({ to: safeRedirect(redirect) });
			} else if (res.status === 401) {
				setError(
					"Invalid credentials or account unavailable. Disabled accounts and expired or reset sessions require help from your Admin. After repeated attempts, wait 15 minutes before retrying.",
				);
			} else {
				setError(
					res.status === 429
						? "Too many attempts. Wait 15 minutes before retrying."
						: "Sign in could not be completed. Please retry.",
				);
			}
		} catch {
			setError(
				"Sign in could not be completed. Check your connection and retry.",
			);
		} finally {
			setPassword("");
			setSubmitting(false);
		}
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-background px-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
					<CardDescription>
						Use your local Glasshouse username and password. Passwords require
						at least 12 characters. Sessions expire after eight hours; sign in
						again if your session has expired.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{passwordChanged && (
						<p
							role="status"
							className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm"
						>
							Your password has been changed. Sign in with your new password.
						</p>
					)}
					{sessionNeedsSignIn() && (
						<p
							role="status"
							className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm"
						>
							Your session expired or is no longer available. Sign in again;
							contact your Admin if your account was disabled or reset.
						</p>
					)}
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
								disabled={submitting}
								maxLength={64}
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
								minLength={12}
								disabled={submitting}
								maxLength={1024}
							/>
						</div>
						{error && (
							<Alert variant="destructive" tabIndex={-1} ref={errorRef}>
								<AlertTitle>Login failed</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<Button type="submit" disabled={submitting} className="w-full">
							{submitting ? "Signing in…" : "Sign in"}
						</Button>
					</form>
					<div className="mt-6 space-y-3 border-t border-border pt-4 text-sm text-muted-foreground">
						<Link
							to="/enroll"
							className="text-foreground underline underline-offset-4"
						>
							Have an enrollment code? Set your password
						</Link>
						<p>
							Forgot your password or account disabled? Contact your Admin for
							re-enrollment. If no usable Admin remains, contact your deployment
							operator for recovery.
						</p>
						<p className="text-xs">
							Basic Auth is an operator/API compatibility path, not this browser
							sign-in.
						</p>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}

export function safeRedirect(value: string | null): string {
	if (
		!value ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		/[\\\x00-\x20]/.test(value)
	) {
		return "/";
	}

	// A stale auth redirect can itself point at /login, which would send a
	// successful login back into the same redirect chain forever.
	if (
		["/login", "/setup", "/enroll"].includes(
			new URL(value, "http://glasshouse.local").pathname,
		)
	) {
		return "/";
	}

	return value;
}
