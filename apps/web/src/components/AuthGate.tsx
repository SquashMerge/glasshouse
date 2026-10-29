import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import {
	expireAuthSession,
	getAuthSession,
	onAuthInvalid,
	readAuthSession,
	refreshAuthSession,
} from "../lib/auth";
import { clearWorkspaceSession } from "./ProjectProvider";
import { Button } from "./ui/button";

const refreshRequiredClients = new WeakSet<object>();
const lastKnownIdentities = new WeakMap<object, string>();

export function AuthGate({ children }: { children: React.ReactNode }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const location = useLocation();
	const [ready, setReady] = React.useState(false);
	const [revalidating, setRevalidating] = React.useState(false);
	const [error, setError] = React.useState(false);
	const [attempt, setAttempt] = React.useState(0);
	const [identity, setIdentity] = React.useState<string>();
	const expiry = React.useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const openRevalidationDialog = React.useCallback(
		(dialog: HTMLDialogElement | null) => {
			if (dialog && !dialog.open) dialog.showModal();
		},
		[],
	);
	React.useEffect(() => () => clearTimeout(expiry.current), []);
	React.useEffect(() => {
		setError(false);
		// The protected layout route is pathless and can remain mounted while
		// navigating to a public auth route. Do not redirect it to itself.
		if (["/login", "/setup", "/enroll"].includes(location.pathname)) {
			clearTimeout(expiry.current);
			setRevalidating(false);
			setReady(true);
			return;
		}

		let active = true;
		let check = 0;
		const redirect = () => {
			if (!active) return;
			check++;
			clearTimeout(expiry.current);
			setReady(false);
			clearWorkspaceSession(queryClient);
			void navigate({ to: "/login" });
		};
		const off = onAuthInvalid(redirect);
		const checkSession = (refresh = false) => {
			const current = ++check;
			const isCurrent = () => active && current === check;
			const refreshWorkspace =
				refresh || refreshRequiredClients.has(queryClient);
			if (refreshWorkspace) refreshRequiredClients.add(queryClient);
			setError(false);
			setRevalidating(true);
			if (!getAuthSession()) setReady(false);
			const sessionCheck = (
				refreshWorkspace ? refreshAuthSession() : readAuthSession()
			).then(async (session) => {
				if (!isCurrent()) return;
				clearTimeout(expiry.current);
				if (!session) {
					setReady(false);
					clearWorkspaceSession(queryClient);
					const response = await fetch("/v1/auth/setup", {
						cache: "no-store",
					});
					if (!response.ok) throw new Error("Setup status unavailable");
					const setup = await response.json();
					if (isCurrent()) {
						void navigate({ to: setup.available ? "/setup" : "/login" });
					}
					return;
				}
				if (session.expires_at) {
					const remaining = Date.parse(session.expires_at) - Date.now();
					if (remaining <= 0) return expireAuthSession();
					expiry.current = setTimeout(expireAuthSession, remaining);
				}
				const nextIdentity = JSON.stringify([
					session.actor_id,
					session.organization_id,
					session.authentication,
					session.username,
				]);
				const previousIdentity = lastKnownIdentities.get(queryClient);
				if (
					previousIdentity &&
					previousIdentity !== nextIdentity &&
					!refreshWorkspace
				) {
					refreshRequiredClients.add(queryClient);
					queryClient.removeQueries({
						predicate: (query) => query.getObserversCount() === 0,
					});
					queryClient.getMutationCache().clear();
					await queryClient.resetQueries();
				}
				if (!isCurrent()) return;
				lastKnownIdentities.set(queryClient, nextIdentity);
				setIdentity(nextIdentity);
				setReady(true);
				return true;
			});
			let queryRefresh = Promise.resolve();
			if (refreshWorkspace) {
				// Reset mounted observers in place; clearing them can leave stale authority visible.
				queryClient.removeQueries({
					predicate: (query) => query.getObserversCount() === 0,
				});
				queryClient.getMutationCache().clear();
				queryRefresh = queryClient.resetQueries();
			}
			void Promise.all([sessionCheck, queryRefresh])
				.then(([valid]) => {
					if (isCurrent() && valid) {
						refreshRequiredClients.delete(queryClient);
						setRevalidating(false);
					}
				})
				.catch(() => {
					if (isCurrent()) {
						refreshRequiredClients.add(queryClient);
						setReady(false);
						setError(true);
					}
				});
		};
		const revalidate = () => {
			checkSession(true);
		};
		checkSession();
		window.addEventListener("focus", revalidate);
		return () => {
			active = false;
			off();
			window.removeEventListener("focus", revalidate);
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
	return (
		<>
			<div
				hidden={revalidating}
				aria-hidden={revalidating || undefined}
				inert={revalidating}
			>
				<React.Fragment key={identity}>{children}</React.Fragment>
			</div>
			{revalidating && (
				<dialog
					ref={openRevalidationDialog}
					aria-label="Checking session"
					aria-modal="true"
					onCancel={(event) => event.preventDefault()}
					className="fixed inset-0 m-0 h-dvh w-screen max-h-none max-w-none border-0 bg-background p-0 text-muted-foreground"
				>
					<div className="grid h-full place-content-center p-6" role="status">
						Checking session…
					</div>
				</dialog>
			)}
		</>
	);
}
