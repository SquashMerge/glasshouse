import * as React from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { expireAuthSession, onAuthInvalid, readAuthSession } from "../lib/auth";
import { clearWorkspaceSession } from "./ProjectProvider";
import { Button } from "./ui/button";

export function AuthGate({ children }: { children: React.ReactNode }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const location = useLocation();
	const [ready, setReady] = React.useState(false);
	const [error, setError] = React.useState(false);
	const [attempt, setAttempt] = React.useState(0);
	React.useEffect(() => {
		setError(false);
		// The protected layout route is pathless and can remain mounted while
		// navigating to a public auth route. Do not redirect it to itself.
		if (["/login", "/setup", "/enroll"].includes(location.pathname)) {
			setReady(true);
			return;
		}

		let active = true;
		let expiry: ReturnType<typeof setTimeout> | undefined;
		setReady(false);
		const redirect = () => {
			if (!active) return;
			setReady(false);
			clearWorkspaceSession(queryClient);
			void navigate({ to: "/login" });
		};
		const off = onAuthInvalid(redirect);
		void readAuthSession()
			.then(async (session) => {
				if (!active) return;
				if (!session) {
					const response = await fetch("/v1/auth/setup", { cache: "no-store" });
					if (!response.ok) throw new Error("Setup status unavailable");
					const setup = await response.json();
					if (active) {
						clearWorkspaceSession(queryClient);
						void navigate({ to: setup.available ? "/setup" : "/login" });
					}
					return;
				}
				if (session.expires_at) {
					const remaining = Date.parse(session.expires_at) - Date.now();
					if (remaining <= 0) return expireAuthSession();
					expiry = setTimeout(expireAuthSession, remaining);
				}
				setReady(true);
			})
			.catch(() => {
				if (active) setError(true);
			});
		return () => {
			active = false;
			off();
			clearTimeout(expiry);
		};
	}, [attempt, location.pathname, location.searchStr, navigate, queryClient]);
	if (error)
		return (
			<div
				className="min-h-screen grid place-content-center gap-4 bg-background p-6 text-center"
				role="alert"
			>
				<p>Session could not be checked.</p>
				<Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
			</div>
		);
	if (!ready)
		return (
			<div
				className="min-h-screen grid place-content-center bg-background text-muted-foreground"
				role="status"
			>
				Checking session…
			</div>
		);
	return <>{children}</>;
}
