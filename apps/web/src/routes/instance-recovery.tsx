import { Card, CardContent, CardHeader } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";

export function InstanceRecoveryPage() {
	return (
		<div className="space-y-8">
			<PageHeader
				title="Instance recovery"
				description="Guidance for coordinating a whole-instance backup or recovery with a trusted host operator."
			/>

			<Card>
				<CardHeader>
					<h2 className="text-lg font-semibold">Whole-instance scope</h2>
				</CardHeader>
				<CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
					<p>
						A backup covers all Organizations and Projects in this Glasshouse
						instance, not just the selected Project. There is no selective
						restore for an individual Organization or Project.
					</p>
					<p>
						Backups contain sensitive data across tenants. Organization Admin
						authority does not grant access to all-tenant archives. Only a
						trusted host operator authorized for the entire instance should
						handle them.
					</p>
					<p>
						This page is informational only: it does not create, validate, list,
						download, or restore backups, or report their status.
					</p>
				</CardContent>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<h2 className="text-lg font-semibold">Prepare and back up</h2>
					</CardHeader>
					<CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
						<p>
							The operator uses the repository's native PostgreSQL and
							ClickHouse backup tooling, then validates the resulting artifact
							and protects it with restricted access and encryption.
						</p>
						<p>
							The two store snapshots are not atomic. Pause ingestion and
							application writes when a tighter consistency point is required;
							record the recovery point. Data loss between the backup and
							recovery is possible.
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<h2 className="text-lg font-semibold">Restore and verify</h2>
					</CardHeader>
					<CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
						<p>
							The operator validates the artifact and restores to an isolated,
							empty target, not the live installation. After restoring, apply
							target migrations and verify representative data in both stores
							before serving traffic.
						</p>
						<p>
							Restored credentials and sessions may bring back earlier access or
							revocations. Before exposing the target, review access, invalidate
							sessions and rotate credentials as appropriate to your security
							plan.
						</p>
					</CardContent>
				</Card>
			</div>

			<section className="space-y-2" aria-labelledby="operator-guide">
				<h2 id="operator-guide" className="text-lg font-semibold">
					Operator instructions
				</h2>
				<p className="text-sm leading-6 text-muted-foreground">
					Contact your trusted host operator and refer to the{" "}
					<a
						href="https://github.com/SquashMerge/glasshouse/blob/main/docs/backup-restore.md"
						className="text-link underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						operator backup and restore guide
					</a>
					. The operator should use the instructions matching the deployed
					version and practice recovery regularly.
				</p>
			</section>
		</div>
	);
}
