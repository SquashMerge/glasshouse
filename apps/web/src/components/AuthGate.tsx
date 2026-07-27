import * as React from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { getCredentials, onAuthInvalid } from "../lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
	const navigate = useNavigate();
	const location = useLocation();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		// The protected layout route is pathless and can remain mounted while
		// navigating to the public login route. Never redirect the login page to
		// itself when there is no active session.
		if (location.pathname === "/login") {
			setReady(true);
			return;
		}

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
	}, [location.pathname, location.searchStr, navigate]);

	if (!ready) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
				Checking session…
			</div>
		);
	}
	return <>{children}</>;
}
