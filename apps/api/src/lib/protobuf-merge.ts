import protobuf from "protobufjs";

// protobufjs skipType accepts any end-group tag and recursively skips without
// matching field numbers or bounding nesting. Validate groups iteratively.
function skipField(reader: protobuf.Reader, tag: number, depth: number): void {
	const wire = tag & 7;
	if (wire === 4) throw new Error("Unexpected protobuf end group");
	if (wire !== 3) {
		reader.skipType(wire);
		return;
	}
	const groups = [tag >>> 3];
	if (depth + groups.length > 64) throw new Error("Protobuf nesting limit");
	while (groups.length) {
		if (reader.pos >= reader.len)
			throw new Error("Unterminated protobuf group");
		const nested = reader.uint32();
		const id = nested >>> 3;
		if (!id) throw new Error("Invalid protobuf tag");
		switch (nested & 7) {
			case 3:
				groups.push(id);
				if (depth + groups.length > 64)
					throw new Error("Protobuf nesting limit");
				break;
			case 4:
				if (groups.pop() !== id)
					throw new Error("Mismatched protobuf end group");
				break;
			default:
				reader.skipType(nested & 7);
				if (reader.pos > reader.len)
					throw new Error("Invalid protobuf message length");
		}
	}
}

// Validate each length-delimited known message before singular occurrences are
// concatenated: a group cannot start in one occurrence and end in another.
function validateMessageBoundaries(
	bytes: Uint8Array,
	type: protobuf.Type,
): void {
	type.resolveAll();
	const stack = [{ reader: protobuf.Reader.create(bytes), type, depth: 0 }];
	while (stack.length) {
		const current = stack[stack.length - 1]!;
		const { reader, depth } = current;
		if (reader.pos === reader.len) {
			stack.pop();
			continue;
		}
		const tag = reader.uint32();
		const id = tag >>> 3;
		if (!id) throw new Error("Invalid protobuf tag");
		const field = current.type.fieldsById[id];
		if ((tag & 7) === 2 && field?.resolvedType instanceof protobuf.Type) {
			if (depth >= 64) throw new Error("Protobuf message nesting limit");
			field.resolvedType.resolveAll();
			stack.push({
				reader: protobuf.Reader.create(reader.bytes()),
				type: field.resolvedType,
				depth: depth + 1,
			});
		} else {
			skipField(reader, tag, depth);
			if (reader.pos > reader.len)
				throw new Error("Invalid protobuf message length");
		}
	}
}

// protobufjs decoders overwrite singular messages and retain conflicting oneof
// properties. Canonicalize known message fields before decoding: concatenate
// singular message occurrences in wire order, and discard earlier alternatives
// whenever a oneof switches. Unknown fields remain opaque to the decoder.
export function mergeProtobufMessages(
	bytes: Uint8Array,
	type: protobuf.Type,
	depth = 0,
): Uint8Array {
	if (depth > 64) throw new Error("Protobuf message nesting limit");
	if (depth === 0) validateMessageBoundaries(bytes, type);
	const reader = protobuf.Reader.create(bytes);
	type.resolveAll();
	type Entry = {
		active: boolean;
		raw?: Uint8Array;
		field?: protobuf.Field;
		parts?: Uint8Array[];
	};
	const entries: Entry[] = [];
	const singular = new Map<number, Entry>();
	const oneofs = new Map<string, { id: number; entries: Entry[] }>();
	while (reader.pos < reader.len) {
		const start = reader.pos;
		const tag = reader.uint32();
		const id = tag >>> 3;
		if (!id) throw new Error("Invalid protobuf tag");
		const field = type.fieldsById[id];
		const wire = tag & 7;
		const expected =
			field?.resolvedType instanceof protobuf.Type
				? 2
				: field?.resolvedType instanceof protobuf.Enum
					? 0
					: field
						? (protobuf.types.basic as Readonly<Record<string, number>>)[
								field.type
							]
						: undefined;
		const packed =
			field?.repeated &&
			wire === 2 &&
			(expected === 0 || expected === 1 || expected === 5);
		if (field && wire !== expected && !packed) {
			// A known number with the wrong wire type is an unknown field, not
			// a oneof selection. protobufjs itself does not check this.
			skipField(reader, tag, depth);
			if (reader.pos > reader.len)
				throw new Error("Invalid protobuf message length");
			continue;
		}
		const message = field?.resolvedType instanceof protobuf.Type && wire === 2;
		let part: Uint8Array | undefined;
		if (message) part = reader.bytes();
		else skipField(reader, tag, depth);
		if (reader.pos > reader.len)
			throw new Error("Invalid protobuf message length");
		let selection: { id: number; entries: Entry[] } | undefined;
		if (field?.partOf) {
			const name = field.partOf.name;
			const previous = oneofs.get(name);
			if (previous && previous.id !== id) {
				for (const entry of previous.entries) entry.active = false;
				singular.delete(previous.id);
			}
			selection = previous?.id === id ? previous : { id, entries: [] };
			oneofs.set(name, selection);
		}
		if (message && field && part) {
			const existing = !field.repeated ? singular.get(id) : undefined;
			if (existing) existing.parts!.push(part);
			else {
				const entry: Entry = { active: true, field, parts: [part] };
				entries.push(entry);
				selection?.entries.push(entry);
				if (!field.repeated) singular.set(id, entry);
			}
		} else {
			const entry = {
				active: true,
				field,
				raw: bytes.subarray(start, reader.pos),
			};
			entries.push(entry);
			selection?.entries.push(entry);
		}
	}
	const chunks: Uint8Array[] = [];
	for (const entry of entries) {
		if (!entry.active) continue;
		if (entry.raw) chunks.push(entry.raw);
		else {
			const field = entry.field!;
			const combined = Buffer.concat(entry.parts!);
			const child = mergeProtobufMessages(
				combined,
				field.resolvedType as protobuf.Type,
				depth + 1,
			);
			chunks.push(
				protobuf.Writer.create()
					.uint32((field.id << 3) | 2)
					.bytes(child)
					.finish(),
			);
		}
	}
	return Buffer.concat(chunks);
}
