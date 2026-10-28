export function clickHouseDateTime(value: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/.exec(
		value,
	);
	return match ? `${match[1]} ${match[2]}` : value;
}
