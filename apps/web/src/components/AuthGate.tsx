import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { getCredentials, onAuthInvalid } from "../lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
	const navigate = useNavigate();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		const creds = getCredentials();
		if (!creds) {
			navigate({ to: "/login" });
		} else {
			setReady(true);
		}

		const off = onAuthInvalid(() => {
			navigate({ to: "/login" });
		});
		return off;
	}, [navigate]);

	if (!ready) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
				Checking session…
			</div>
		);
	}
	return <>{children}</>;
}
