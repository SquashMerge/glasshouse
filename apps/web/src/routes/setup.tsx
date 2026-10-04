import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AuthCard, FirstPasswordForm } from "../components/LocalAuthForm";
import { Button } from "../components/ui/button";

export function SetupPage() {
	const [completed, setCompleted] = React.useState(false);
	const availability = useQuery({
		queryKey: ["auth", "setup"],
		retry: false,
		staleTime: 0,
		queryFn: async () => {
			const response = await fetch("/v1/auth/setup", { cache: "no-store" });
			if (!response.ok) throw new Error("Setup status unavailable");
			return response.json() as Promise<{ available: boolean }>;
		},
	});
	return (
		<AuthCard
			title="Set up Astraea"
			description="Create the first local Admin for this deployment. Your organization and initial Project access are assigned by the server."
		>
			{completed ? (
				<div className="space-y-4" role="status">
					<p>
						Your Admin account is ready. Sign in with your username and
						password.
					</p>
					<Link to="/login" className="underline">
						Sign in
					</Link>
				</div>
			) : availability.isPending ? (
				<p role="status">Checking setup availability…</p>
			) : availability.isError ? (
				<div className="space-y-4" role="alert">
					<p>Setup availability could not be checked.</p>
					<Button onClick={() => void availability.refetch()}>Retry</Button>
				</div>
			) : availability.data.available ? (
				<FirstPasswordForm
					setup
					onComplete={() => {
						setCompleted(true);
						void availability.refetch();
					}}
					onUnavailable={() => {
						void availability.refetch();
					}}
				/>
			) : (
				<div className="space-y-4" role="status">
					<p>
						Setup is unavailable or already initialized. Contact your deployment
						operator if you need access.
					</p>
					<Link to="/login" className="underline">
						Sign in
					</Link>
				</div>
			)}
		</AuthCard>
	);
}
