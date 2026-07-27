import * as React from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { getCredentials, onAuthInvalid } from "../lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
	const navigate = useNavigate();
	const location = useLocation();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		const creds = getCredentials();
		if (!creds) {
			navigate({
				to: "/login",
				search: { redirect: `${location.pathname}${location.searchStr}` },
			});
		} else {
			setReady(true);
		}

		const off = onAuthInvalid(() => {
			navigate({
				to: "/login",
				search: { redirect: `${location.pathname}${location.searchStr}` },
			});
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
