import * as React from "react";
import { Link } from "@tanstack/react-router";
import { AuthCard, FirstPasswordForm } from "../components/LocalAuthForm";

export function EnrollmentPage() {
	const [completed, setCompleted] = React.useState(false);
	return (
		<AuthCard
			title="Set your password"
			description="Use the one-time enrollment code handed to you by your Admin. Public self-registration is disabled."
		>
			{completed ? (
				<div className="space-y-4" role="status">
					<p>
						Your password is set. Sign in with the username provided by your
						Admin.
					</p>
					<Link to="/login" className="underline">
						Sign in
					</Link>
				</div>
			) : (
				<FirstPasswordForm
					setup={false}
					onComplete={() => setCompleted(true)}
				/>
			)}
		</AuthCard>
	);
}
