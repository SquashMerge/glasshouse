import * as React from "react";

type JsonType =
	| "array"
	| "boolean"
	| "null"
	| "number"
	| "object"
	| "string"
	| "undefined";

type TreeLimitReason = "children" | "depth" | "nodes" | null;

interface JsonTreeProps {
	value: unknown;
	rootLabel: string;
	onCopyValue?: (value: unknown, path: string) => void;
	onCopyPath?: (path: string) => void;
	maxNodes?: number;
	expandAllByDefault?: boolean;
}

interface JsonTreeNode {
	value: unknown;
	key: string;
	path: string;
	depth: number;
	type: JsonType;
	itemCount: number;
	children: JsonTreeNode[];
	omittedCount: number;
	limitReason: TreeLimitReason;
	circular: boolean;
}

export const MAX_JSON_TREE_NODES = 500;
const MAX_CHILDREN_PER_CONTAINER = 100;
const MAX_TREE_DEPTH = 12;

function valueType(value: unknown): JsonType {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	return "undefined";
}

function childPath(path: string, key: string, parentType: JsonType): string {
	if (parentType === "array") return `${path}[${key}]`;
	if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${path}.${key}`;
	return `${path}[${JSON.stringify(key)}]`;
}

function getItemCount(value: object): number {
	return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function getEntries(value: object, limit: number): Array<[string, unknown]> {
	if (Array.isArray(value))
		return value.slice(0, limit).map((entry, index) => [String(index), entry]);
	return Object.keys(value)
		.slice(0, limit)
		.map((key) => [key, (value as Record<string, unknown>)[key]]);
}

function buildTreeNode(
	value: unknown,
	key: string,
	path: string,
	depth: number,
	budget: { remaining: number },
	ancestors: Set<object>,
): JsonTreeNode {
	const type = valueType(value);
	const node: JsonTreeNode = {
		value,
		key,
		path,
		depth,
		type,
		itemCount: 0,
		children: [],
		omittedCount: 0,
		limitReason: null,
		circular: false,
	};
	if (type !== "array" && type !== "object") return node;

	const container = value as object;
	node.itemCount = getItemCount(container);
	if (ancestors.has(container)) {
		node.circular = true;
		return node;
	}
	if (node.itemCount === 0) return node;
	if (depth >= MAX_TREE_DEPTH) {
		node.omittedCount = node.itemCount;
		node.limitReason = "depth";
		return node;
	}

	ancestors.add(container);
	const childEntries = getEntries(
		container,
		Math.min(node.itemCount, MAX_CHILDREN_PER_CONTAINER),
	);
	for (const [childKey, childValue] of childEntries) {
		if (budget.remaining <= 0) {
			node.omittedCount = node.itemCount - node.children.length;
			node.limitReason = "nodes";
			break;
		}
		budget.remaining -= 1;
		node.children.push(
			buildTreeNode(
				childValue,
				childKey,
				childPath(path, childKey, type),
				depth + 1,
				budget,
				ancestors,
			),
		);
	}
	ancestors.delete(container);

	if (node.children.length < node.itemCount && node.limitReason === null) {
		node.omittedCount = node.itemCount - node.children.length;
		node.limitReason =
			node.itemCount > MAX_CHILDREN_PER_CONTAINER ? "children" : "nodes";
	}
	return node;
}

function countNodes(node: JsonTreeNode): number {
	return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function isExpandable(node: JsonTreeNode): boolean {
	return (
		(node.type === "object" || node.type === "array") &&
		(node.itemCount > 0 || node.omittedCount > 0) &&
		!node.circular
	);
}

function getExpandablePaths(node: JsonTreeNode): string[] {
	return [
		...(isExpandable(node) ? [node.path] : []),
		...node.children.flatMap(getExpandablePaths),
	];
}

function containsOmittedContent(node: JsonTreeNode): boolean {
	return (
		node.omittedCount > 0 ||
		node.circular ||
		node.children.some(containsOmittedContent)
	);
}

function displayScalar(value: unknown, type: JsonType): string {
	if (type === "string") return JSON.stringify(value);
	if (type === "null") return "null";
	if (type === "undefined") return "undefined";
	return String(value);
}

function omittedMessage(node: JsonTreeNode, maxNodes: number): string {
	if (node.circular) return "Circular reference not expanded.";
	if (node.limitReason === "depth")
		return `Depth limit (${MAX_TREE_DEPTH} levels) reached. ${node.omittedCount} nested ${node.omittedCount === 1 ? "item" : "items"} not rendered.`;
	if (node.limitReason === "nodes")
		return `${node.omittedCount} more ${node.omittedCount === 1 ? "item" : "items"} not shown (${maxNodes}-node limit).`;
	return `${node.omittedCount} more ${node.omittedCount === 1 ? "item" : "items"} not shown (${MAX_CHILDREN_PER_CONTAINER}-item limit).`;
}

const TYPE_CLASS: Record<JsonType, string> = {
	array: "text-json-type-array",
	boolean: "text-json-type-boolean",
	null: "text-muted-foreground",
	number: "text-json-type-number",
	object: "text-json-type-object",
	string: "text-json-type-string",
	undefined: "text-muted-foreground",
};

export function JsonTree({
	value,
	rootLabel,
	onCopyValue,
	onCopyPath,
	maxNodes = MAX_JSON_TREE_NODES,
	expandAllByDefault = false,
}: JsonTreeProps) {
	const nodeLimit = Math.max(
		1,
		Math.min(MAX_JSON_TREE_NODES, Math.floor(maxNodes)),
	);
	const root = React.useMemo(
		() =>
			buildTreeNode(
				value,
				rootLabel,
				"$",
				0,
				{
					remaining: nodeLimit - 1,
				},
				new Set(),
			),
		[nodeLimit, value, rootLabel],
	);
	const expandablePaths = React.useMemo(() => getExpandablePaths(root), [root]);
	const [expandedPaths, setExpandedPaths] = React.useState(
		() => new Set(expandAllByDefault ? expandablePaths : ["$"]),
	);

	React.useEffect(() => {
		setExpandedPaths(new Set(expandAllByDefault ? expandablePaths : ["$"]));
	}, [expandAllByDefault, expandablePaths]);

	function toggle(path: string) {
		setExpandedPaths((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}

	const allExpanded = expandablePaths.every((path) => expandedPaths.has(path));
	function toggleAll() {
		setExpandedPaths(new Set(allExpanded ? [] : expandablePaths));
	}

	function renderNode(node: JsonTreeNode): React.ReactNode {
		const expandable = isExpandable(node);
		const expanded = expandedPaths.has(node.path);
		const summary = `${node.type}, ${node.itemCount} ${node.itemCount === 1 ? "item" : "items"}`;
		const label = node.depth === 0 ? rootLabel : node.path;

		return (
			<li key={node.path} className="min-w-0 py-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					{expandable ? (
						<button
							type="button"
							className="max-w-full break-all rounded-sm text-left font-mono text-xs font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-expanded={expanded}
							aria-label={`${expanded ? "Collapse" : "Expand"} ${label} (${summary})`}
							onClick={() => toggle(node.path)}
						>
							<span aria-hidden="true" className="mr-1 text-muted-foreground">
								{expanded ? "▾" : "▸"}
							</span>
							{node.depth === 0 ? rootLabel : node.key}
						</button>
					) : (
						<span className="max-w-full break-all font-mono text-xs">
							{node.depth === 0 ? rootLabel : node.key}
						</span>
					)}
					<span
						data-json-type={node.type}
						className={`min-w-0 break-all font-mono text-xs ${TYPE_CLASS[node.type]}`}
					>
						{node.type === "object" || node.type === "array"
							? `${node.type} (${node.itemCount})`
							: displayScalar(node.value, node.type)}
					</span>
					{onCopyValue && (
						<button
							type="button"
							className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={`Copy JSON value at ${node.path}`}
							onClick={() => onCopyValue(node.value, node.path)}
						>
							Copy value
						</button>
					)}
					{onCopyPath && (
						<button
							type="button"
							className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={`Copy JSON path ${node.path}`}
							onClick={() => onCopyPath(node.path)}
						>
							Copy path
						</button>
					)}
				</div>
				{expandable && expanded && (
					<ul className="ml-3 min-w-0 border-l pl-3">
						{node.children.map(renderNode)}
						{node.omittedCount > 0 && (
							<li className="break-words py-0.5 text-xs text-muted-foreground">
								{omittedMessage(node, nodeLimit)}
							</li>
						)}
					</ul>
				)}
			</li>
		);
	}

	const isLimited = containsOmittedContent(root);
	return (
		<div
			data-testid="json-tree"
			data-json-tree-node-count={countNodes(root)}
			className="min-w-0 max-w-full overflow-x-auto rounded-md border bg-muted/20 p-2 text-xs"
		>
			{expandablePaths.length > 0 && (
				<div className="mb-1 flex justify-end">
					<button
						type="button"
						className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={`${allExpanded ? "Collapse" : "Expand"} all JSON nodes`}
						onClick={toggleAll}
					>
						{allExpanded ? "Collapse all" : "Expand all"}
					</button>
				</div>
			)}
			{isLimited && (
				<p
					data-testid="json-tree-limit-notice"
					className="mb-2 text-xs text-muted-foreground"
				>
					Limited view: up to {nodeLimit} nodes, {MAX_CHILDREN_PER_CONTAINER}{" "}
					items per object/array, and {MAX_TREE_DEPTH} levels deep. Omitted
					content is identified below.
				</p>
			)}
			<ul className="min-w-0">{renderNode(root)}</ul>
		</div>
	);
}
