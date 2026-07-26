#!/usr/bin/env python3
"""JSON-lines boundary for the optional GEPA runtime; credentials stay outside Astraea."""
import json
import os
import sys

def request_value(request, name, expected_type):
    value = request.get(name)
    if not isinstance(value, expected_type):
        raise ValueError(f"{name} is required")
    return value


def validate_request(request):
    source = request_value(request, "source", str)
    evaluator = request_value(request, "evaluator", dict)
    if evaluator != {"type": "default_adapter"}:
        raise ValueError("evaluator must be the default_adapter")
    examples = request_value(request, "examples", list)
    if not examples or not all(
        isinstance(example, dict)
        and isinstance(example.get("input"), str)
        and isinstance(example.get("answer"), str)
        for example in examples
    ):
        raise ValueError("examples must contain input and answer strings")
    model_config = request_value(request, "model_config", dict)
    task_lm = model_config.get("task_lm")
    reflection_lm = model_config.get("reflection_lm")
    if not isinstance(task_lm, str) or not isinstance(reflection_lm, str):
        raise ValueError("model_config requires task_lm and reflection_lm")
    budget = request_value(request, "budget", dict)
    max_metric_calls = budget.get("max_metric_calls")
    if not isinstance(max_metric_calls, int) or isinstance(max_metric_calls, bool) or max_metric_calls < 1:
        raise ValueError("budget.max_metric_calls must be a positive integer")
    trainset = [
        {
            "input": example["input"],
            "answer": example["answer"],
            "additional_context": example.get("additional_context", {}),
        }
        for example in examples
    ]
    return source, trainset, task_lm, reflection_lm, max_metric_calls


def fake_optimize(source):
    return {"candidate": source + "\n\nOptimize for clear, accurate answers."}


try:
    request = json.loads(sys.stdin.readline())
    source, trainset, task_lm, reflection_lm, max_metric_calls = validate_request(request)
except (ValueError, json.JSONDecodeError) as error:
    sys.stderr.write(str(error))
    sys.exit(2)

# The deterministic adapter validates the identical contract without credentials.
if os.environ.get("GEPA_WORKER_MODE") == "fake":
    print(json.dumps(fake_optimize(source)))
    sys.exit(0)

try:
    import gepa  # type: ignore # Installed only in the isolated worker image.
except ImportError:
    sys.stderr.write("GEPA is not installed in the worker environment")
    sys.exit(2)

try:
    result = gepa.optimize(
        seed_candidate={"system_prompt": source},
        trainset=trainset,
        valset=trainset,
        task_lm=task_lm,
        reflection_lm=reflection_lm,
        max_metric_calls=max_metric_calls,
    )
    candidate = result.best_candidate["system_prompt"]
    score = result.val_aggregate_scores[result.best_idx]
    print(json.dumps({"candidate": candidate, "score": score}))
except Exception as error:
    sys.stderr.write(f"GEPA optimization failed: {error}")
    sys.exit(1)
