def build_reflective_feedback(data, generated_response, score):
    answer = data["answer"]
    if score > 0.0:
        return (
            "The generated response matched the reference answer. The reference answer "
            "is evaluation-only evidence for this example, not a response template. "
            "Preserve reusable behavior in the system prompt without copying the "
            "example's wording."
        )

    additional_context = "\n".join(
        f"{key}: {value}"
        for key, value in data.get("additional_context", {}).items()
    )
    return (
        "The generated response did not match the reference answer. Use the reference "
        "answer only as evaluation-only evidence about this example; Do not copy it, "
        "quote it, or prescribe its exact wording in the reusable system prompt. "
        "Improve the system prompt with generalizable instructions that help produce "
        "the appropriate answer for this input and for similar future inputs.\n"
        f"Reference answer (evaluation-only): {answer}\n"
        "Additional context:\n"
        f"{additional_context}"
    )
