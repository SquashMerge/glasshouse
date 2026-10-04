import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ApiError,
	listLocalAccounts,
	provisionLocalAccount,
	resetLocalAccount,
	revokeLocalEnrollment,
	setAdminActorRole,
	setLocalAccountEnabled,
	type EnrollmentCode,
	type LocalAccount,
} from "../lib/api";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select } from "./ui/select";
import { Badge } from "./ui/badge";
import { getAuthSession } from "../lib/auth";

type Role = NonNullable<LocalAccount["organization_role"]>;
type Confirmation = { account: LocalAccount; action: "disable" | "reset" };
export function LocalAccounts() {
	const queryClient = useQueryClient();
	const accounts = useQuery({
		queryKey: ["admin", "local-accounts"],
		queryFn: listLocalAccounts,
	});
	const [username, setUsername] = React.useState("");
	const [role, setRole] = React.useState<Role>("read_only");
	const [code, setCode] = React.useState<EnrollmentCode | null>(null);
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [confirmation, setConfirmation] = React.useState<Confirmation | null>(
		null,
	);
	const codeRef = React.useRef<HTMLInputElement>(null);
	const errorRef = React.useRef<HTMLParagraphElement>(null);
	const provisionRef = React.useRef<HTMLButtonElement>(null);
	const confirmRef = React.useRef<HTMLButtonElement>(null);
	React.useEffect(() => {
		if (code) codeRef.current?.focus();
	}, [code]);
	React.useEffect(() => {
		if (error) errorRef.current?.focus();
	}, [error]);
	React.useEffect(() => {
		if (confirmation) confirmRef.current?.focus();
	}, [confirmation]);
	function refreshAccess() {
		void queryClient.invalidateQueries({ queryKey: ["admin"] });
		void queryClient.invalidateQueries({ queryKey: ["me"] });
		void queryClient.invalidateQueries({ queryKey: ["projects"] });
	}
	async function change(operation: () => Promise<EnrollmentCode | void>) {
		if (pending || code) return;
		setPending(true);
		setError(null);
		setNotice(null);
		try {
			const result = await operation();
			setConfirmation(null);
			if (result) setCode(result);
			else setNotice("Account change saved.");
			// Self-reset revokes this session. Keep its authorized one-time response
			// visible until dismissal, rather than immediately refetching into 401.
			if (!result || result.actor_id !== getAuthSession()?.actor_id)
				refreshAccess();
		} catch (cause) {
			setError(
				cause instanceof ApiError && cause.status === 409
					? "Account change unavailable. Check the username and current state. Keep another enrolled, enabled Admin before disabling, resetting or demoting an Admin."
					: "Account change could not be completed. Check your access and connection, then refresh the account list. Do not repeat a provisioning/reset request blindly: a lost response may have committed; issue a fresh code through re-enrollment.",
			);
		} finally {
			setPending(false);
		}
	}
	return (
		<section className="space-y-6" aria-label="Local account management">
			<Card>
				<CardHeader>
					<CardTitle>Local accounts</CardTitle>
					<CardDescription>
						Provision usernames with existing roles. Hand off the one-time code
						privately. User and Read-only accounts need explicit Project grants
						below.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<form
						className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
						onSubmit={(event) => {
							event.preventDefault();
							void change(async () => {
								const result = await provisionLocalAccount(username, role);
								setUsername("");
								return result;
							});
						}}
					>
						<div className="space-y-2">
							<Label htmlFor="provision-username">New username</Label>
							<Input
								id="provision-username"
								autoComplete="off"
								required
								minLength={3}
								maxLength={64}
								pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}"
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								disabled={pending || Boolean(code)}
								aria-describedby="provision-help"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="provision-role">Organization role</Label>
							<Select
								id="provision-role"
								value={role}
								onChange={(event) => setRole(event.target.value as Role)}
								disabled={pending || Boolean(code)}
							>
								<RoleOptions />
							</Select>
						</div>
						<Button
							type="submit"
							ref={provisionRef}
							disabled={pending || Boolean(code)}
						>
							{pending ? "Saving…" : "Provision account"}
						</Button>
					</form>
					<p id="provision-help" className="text-xs text-muted-foreground">
						3–64 ASCII characters; start with a letter or number, then letters,
						numbers, dots, underscores or hyphens. Case is normalized. No public
						sign-up.
					</p>
					{error && (
						<p
							ref={errorRef}
							tabIndex={-1}
							role="alert"
							className="text-sm text-destructive"
						>
							{error}
						</p>
					)}
					{notice && (
						<p role="status" className="text-sm">
							{notice}
						</p>
					)}
					{code && (
						<div
							className="space-y-3 rounded-md border border-border bg-muted/40 p-4"
							role="region"
							aria-label="One-time enrollment handoff"
						>
							<Label htmlFor="one-time-code">
								Enrollment code (shown once)
							</Label>
							<Input
								id="one-time-code"
								ref={codeRef}
								value={code.code}
								readOnly
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
							/>
							<p className="text-sm text-muted-foreground">
								Valid for seven days. Privately give this code and the username
								to the account holder. They enter it at /enroll. It cannot be
								retrieved after dismissal or reload; never put it in a URL or
								support diagnostics.
							</p>
							<Button
								type="button"
								className="h-auto w-full whitespace-normal py-2"
								onClick={() => {
									setCode(null);
									setNotice(
										"Enrollment code dismissed. It cannot be retrieved again.",
									);
									refreshAccess();
									requestAnimationFrame(() => provisionRef.current?.focus());
								}}
							>
								I have handed off the code — dismiss
							</Button>
						</div>
					)}
				</CardContent>
			</Card>
			{confirmation && (
				<Card>
					<CardHeader>
						<CardTitle className="break-all">
							{confirmation.action === "disable" ? "Disable" : "Re-enroll"}{" "}
							{confirmation.account.username}?
						</CardTitle>
						<CardDescription>
							This revokes every current session and outstanding enrollment.
							Re-enrollment also removes the password. Another usable Admin must
							remain.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-wrap gap-3">
						<Button
							type="button"
							variant="destructive"
							ref={confirmRef}
							disabled={pending || Boolean(code)}
							onClick={() =>
								void change(() =>
									confirmation.action === "reset"
										? resetLocalAccount(confirmation.account.actor_id)
										: setLocalAccountEnabled(
												confirmation.account.actor_id,
												false,
											),
								)
							}
						>
							Confirm{" "}
							{confirmation.action === "reset" ? "re-enrollment" : "disable"}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => {
								setConfirmation(null);
								provisionRef.current?.focus();
							}}
						>
							Cancel
						</Button>
					</CardContent>
				</Card>
			)}
			{accounts.isPending ? (
				<p role="status" className="text-muted-foreground">
					Loading local accounts…
				</p>
			) : accounts.isError ? (
				<div className="space-y-3" role="alert">
					<p>Local accounts could not be loaded.</p>
					<Button variant="outline" onClick={() => void accounts.refetch()}>
						Retry local accounts
					</Button>
				</div>
			) : accounts.data.items.length === 0 ? (
				<p className="text-muted-foreground">
					No local accounts. Provision a username to get started.
				</p>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{accounts.data.items.map((account) => (
						<Card key={account.actor_id}>
							<CardHeader>
								<div className="flex flex-wrap items-center justify-between gap-3">
									<CardTitle className="break-all">
										{account.username}
									</CardTitle>
									<Badge variant="outline">{account.status}</Badge>
								</div>
								<CardDescription className="break-all">
									Actor {account.actor_id}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-5">
								<div className="space-y-2">
									<Label
										className="break-all"
										htmlFor={`local-role-${account.actor_id}`}
									>
										Role for {account.username}
									</Label>
									<Select
										id={`local-role-${account.actor_id}`}
										value={account.organization_role ?? ""}
										disabled={pending || Boolean(code)}
										onChange={(event) =>
											void change(async () => {
												await setAdminActorRole({
													actorId: account.actor_id,
													role: event.target.value as Role,
												});
											})
										}
									>
										<option value="" disabled>
											Unassigned
										</option>
										<RoleOptions />
									</Select>
								</div>
								<p className="text-sm text-muted-foreground">
									{account.organization_role === "admin"
										? "Admin access uses the existing organization policy."
										: `${account.project_grants.length} explicit Project grant(s). Manage grants below.`}
								</p>
								<div className="flex flex-wrap gap-3">
									<Button
										aria-label={`${account.status === "disabled" ? "Enable" : "Disable"} ${account.username}`}
										variant="outline"
										disabled={pending || Boolean(code)}
										onClick={() =>
											account.status === "disabled"
												? void change(() =>
														setLocalAccountEnabled(account.actor_id, true),
													)
												: setConfirmation({ account, action: "disable" })
										}
									>
										{account.status === "disabled" ? "Enable" : "Disable"}
									</Button>
									<Button
										aria-label={`Re-enroll ${account.username}`}
										variant="outline"
										disabled={
											pending || Boolean(code) || account.status === "disabled"
										}
										onClick={() =>
											setConfirmation({ account, action: "reset" })
										}
									>
										Re-enroll
									</Button>
								</div>
								<div className="space-y-3 border-t border-border pt-4">
									<h3 className="text-sm font-medium">Enrollments</h3>
									{account.enrollments.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No enrollment history.
										</p>
									) : (
										<ul className="space-y-3">
											{account.enrollments.map((enrollment) => (
												<li
													key={enrollment.id}
													className="flex flex-wrap items-center justify-between gap-3 text-sm"
												>
													<span>
														{enrollment.status} · expires{" "}
														{new Date(
															enrollment.expires_at,
														).toLocaleDateString()}
													</span>
													{enrollment.status === "pending" && (
														<Button
															aria-label={`Revoke enrollment for ${account.username}`}
															size="sm"
															variant="outline"
															disabled={pending || Boolean(code)}
															onClick={() =>
																void change(() =>
																	revokeLocalEnrollment(enrollment.id),
																)
															}
														>
															Revoke enrollment
														</Button>
													)}
												</li>
											))}
										</ul>
									)}
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</section>
	);
}
function RoleOptions() {
	return (
		<>
			<option value="admin">Admin</option>
			<option value="user">User</option>
			<option value="read_only">Read-only</option>
		</>
	);
}
