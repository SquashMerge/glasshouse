import { describe, expect, it } from "bun:test";
import {
	checkExpectedAnswerLeakage,
	validateGepaCandidate,
} from "../../src/routes/prompt-optimizations";

describe("GEPA candidate validation", () => {
	it("rejects a malformed candidate even when its Mustache tokens match", () => {
		expect(() =>
			validateGepaCandidate("Hello {{name}}", "Hello {{name"),
		).toThrow("malformed");
	});

	it("accepts exactly 4096 characters and rejects 4097", () => {
		expect(() => validateGepaCandidate("x", "x".repeat(4096))).not.toThrow();
		expect(() => validateGepaCandidate("x", "x".repeat(4097))).toThrow(
			"4096 characters",
		);
	});

	it("accepts exactly 128 lines and rejects 129", () => {
		const lines = Array.from({ length: 128 }, () => "x").join("\n");
		expect(() => validateGepaCandidate("x", lines)).not.toThrow();
		expect(() => validateGepaCandidate("x", `${lines}\nx`)).toThrow(
			"128 lines",
		);
	});

	it("rejects the reported daily-summary answer while preserving {{tasks}}", () => {
		const expectedAnswer =
			"**Today’s priorities:** Finish and send the quarterly status report by 2:00 PM, then review and approve the API pull request.  \n**After work:** Pick up groceries, schedule a dental cleaning, and take the dog for a 30-minute walk.";
		const candidate = `Summarize {{tasks}} by urgency and timing.\n\nFor the provided task list, respond exactly:\n${expectedAnswer}`;

		expect(() =>
			validateGepaCandidate("Summarize {{tasks}}", candidate, [expectedAnswer]),
		).toThrow("expected-answer material");
	});

	it("rejects a material normalized span from an expected answer", () => {
		const expectedAnswer =
			"Prioritize the customer renewal proposal before noon, prepare the planning meeting notes, refill the prescription after work, and water the plants tonight.";
		const candidate =
			"Summarize {{tasks}} concisely. Prioritize the customer renewal proposal before noon, prepare the planning meeting notes, refill the prescription after work.";

		expect(checkExpectedAnswerLeakage(candidate, [expectedAnswer])).toEqual({
			status: "failed",
			reason: "expected_answer_material_span",
		});
	});

	it("rejects copied example input material", () => {
		const exampleInput =
			"Customer SSN 123-45-6789 and routing number 021000021 require review.";
		const obfuscatedInput = exampleInput.replace("number", "nurnber");
		expect(() =>
			validateGepaCandidate(
				"Summarize {{tasks}}",
				`Summarize {{tasks}}. ${obfuscatedInput}`,
				["Classify the submitted records as incomplete."],
				[exampleInput],
			),
		).toThrow("example input material");
	});

	it("normalizes case and apostrophe variants before checking a full answer", () => {
		expect(
			checkExpectedAnswerLeakage(
				"Always say: the customers renewal must be sent before noon today.",
				["The customer’s renewal must be sent before noon today."],
			),
		).toEqual({ status: "failed", reason: "expected_answer_full_match" });
	});

	it("blocks short full labels and default-ignorable or punctuation obfuscation", () => {
		expect(checkExpectedAnswerLeakage("Always answer Yes.", ["Yes"])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
		expect(checkExpectedAnswerLeakage("Always answer Y-e-s.", ["Yes"])).toEqual(
			{
				status: "failed",
				reason: "expected_answer_full_match",
			},
		);
		expect(checkExpectedAnswerLeakage("Return O.K.", ["OK"])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
		expect(
			checkExpectedAnswerLeakage(
				"Respond with the cus\u200btomer renewal proposal before noon today.",
				["Respond with the customer renewal proposal before noon today."],
			),
		).toEqual({ status: "failed", reason: "expected_answer_full_match" });
		expect(
			checkExpectedAnswerLeakage("Always answer Y\u115fes.", ["Yes"]),
		).toEqual({ status: "failed", reason: "expected_answer_full_match" });
		expect(
			checkExpectedAnswerLeakage(
				"Always answer: the custоmer renewal must be sent before noon today.",
				["The customer renewal must be sent before noon today."],
			),
		).toEqual({ status: "failed", reason: "expected_answer_full_match" });
		expect(checkExpectedAnswerLeakage("Always return ΑΒC.", ["ABC"])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
		expect(checkExpectedAnswerLeakage("Always return αβc.", ["ABC"])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
		expect(
			checkExpectedAnswerLeakage("Always return ＡＢＣ.", ["ABC"]),
		).toEqual({ status: "failed", reason: "expected_answer_full_match" });
	});

	it("blocks material copied in ordered chunks with filler words", () => {
		const expectedAnswer =
			"first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth twentyfirst twentytwo";
		const candidate =
			"first second third fourth fifth sixth seventh clarify the general format eighth ninth tenth eleventh twelfth thirteenth fourteenth clarify the general format fifteenth sixteenth seventeenth eighteenth nineteenth twentieth twentyfirst twentytwo";

		expect(checkExpectedAnswerLeakage(candidate, [expectedAnswer])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
	});

	it("blocks ordered material separated by arbitrarily many filler words", () => {
		const expectedAnswer =
			"first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth twentyfirst twentytwo";
		const candidate = expectedAnswer
			.split(" ")
			.map(
				(token) =>
					`${token} context filler alpha beta gamma delta epsilon zeta eta theta iota`,
			)
			.join(" ");

		expect(checkExpectedAnswerLeakage(candidate, [expectedAnswer])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
	});

	it("blocks complete and material expected-answer copies with reordered tokens", () => {
		const expectedAnswer =
			"first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth";
		const reversed = expectedAnswer.split(" ").reverse().join(" ");

		expect(checkExpectedAnswerLeakage(reversed, [expectedAnswer])).toEqual({
			status: "failed",
			reason: "expected_answer_full_match",
		});
		expect(
			checkExpectedAnswerLeakage(
				"summarize safely eighth seventh sixth fifth fourth third second first",
				[expectedAnswer],
			),
		).toEqual({
			status: "failed",
			reason: "expected_answer_material_span",
		});
	});

	it("accepts generalized held-out instructions without expected-answer material", () => {
		const expectedAnswer =
			"**Today’s priorities:** Finish and send the quarterly status report by 2:00 PM, then review and approve the API pull request.  \n**After work:** Pick up groceries, schedule a dental cleaning, and take the dog for a 30-minute walk.";
		const candidate =
			"Summarize {{tasks}} with concise headings. Prioritize deadlines, retain each task's timing, and group remaining work by when it should happen.";

		expect(() =>
			validateGepaCandidate("Summarize {{tasks}}", candidate, [expectedAnswer]),
		).not.toThrow();
	});
});
