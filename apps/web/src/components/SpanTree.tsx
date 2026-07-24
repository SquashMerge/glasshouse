import * as React from "react";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

export interface ObservationLike {
	observation_id: string;
	parent_observation_id: string | null;
	name: string;
	start_time: string;
	duration_ms: number | null;
	status: "ok" | "error";
	model: string | null;
	input_text: string;
	output_text: string;
	metadata?: string;
}

interface TreeNode {
	obs: ObservationLike;
	children: TreeNode[];
}

function buildTree(observations: ObservationLike[]): TreeNode[] {
	const byId = new Map<string, TreeNode>();
	for (const o of observations)
		byId.set(o.observation_id, { obs: o, children: [] });
	const roots: TreeNode[] = [];
	for (const o of observations) {
		const node = byId.get(o.observation_id)!;
		if (o.parent_observation_id && byId.has(o.parent_observation_id)) {
			byId.get(o.parent_observation_id)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

function formatDuration(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
	const hasChildren = node.children.length > 0;
	return (
		<div
			className={cn(
				"space-y-1",
				depth > 0 && "ml-4 border-l border-border pl-3",
			)}
		>
			<details open={depth < 2}>
				<summary className="cursor-pointer select-none flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
					<Badge
						variant={node.obs.status === "error" ? "destructive" : "secondary"}
					>
						{node.obs.name}
					</Badge>
					{node.obs.model && <Badge variant="outline">{node.obs.model}</Badge>}
					<span className="text-xs text-muted-foreground">
						{formatDuration(node.obs.duration_ms)}
					</span>
					{hasChildren && (
						<span className="text-xs text-muted-foreground">
							({node.children.length} children)
						</span>
					)}
				</summary>
				{(node.obs.input_text || node.obs.output_text) && (
					<Card className="mt-2 p-3 space-y-2">
						{node.obs.input_text && (
							<div>
								<div className="text-xs font-medium text-muted-foreground">
									Input
								</div>
								<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
									{node.obs.input_text}
								</pre>
							</div>
						)}
						{node.obs.output_text && (
							<div>
								<div className="text-xs font-medium text-muted-foreground">
									Output
								</div>
								<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
									{node.obs.output_text}
								</pre>
							</div>
						)}
					</Card>
				)}
				{hasChildren && (
					<div className="mt-2 space-y-1">
						{node.children.map((c) => (
							<NodeView key={c.obs.observation_id} node={c} depth={depth + 1} />
						))}
					</div>
				)}
			</details>
		</div>
	);
}

export function SpanTree({
	observations,
}: {
	observations: ObservationLike[];
}) {
	const tree = React.useMemo(() => buildTree(observations), [observations]);
	if (tree.length === 0) {
		return (
			<div className="text-sm text-muted-foreground">No observations.</div>
		);
	}
	return (
		<div className="space-y-2">
			{tree.map((root) => (
				<NodeView key={root.obs.observation_id} node={root} depth={0} />
			))}
		</div>
	);
}
