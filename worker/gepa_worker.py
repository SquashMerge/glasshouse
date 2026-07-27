#!/usr/bin/env python3
"""JSON-lines boundary for the optional GEPA runtime; credentials stay outside Astraea."""
import json
import os
import sys

if __package__:
    from .dev_cli_llm import DevCliLlmError, reflection_lm_for_model, task_lm_for_model
else:
    from dev_cli_llm import DevCliLlmError, reflection_lm_for_model, task_lm_for_model

MAX_METRIC_CALLS = 100


class StderrLogger:
    """Keep GEPA progress off stdout, which is the worker's JSON protocol."""

    def log(self, message):
        print(message, file=sys.stderr, flush=True)


def allowed_models():
    models = [model.strip() for model in os.environ.get("GEPA_ALLOWED_MODELS", "").split(",") if model.strip()]
    if not models:
        raise ValueError("GEPA_ALLOWED_MODELS must configure at least one model")
    return set(models)

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
    if task_lm not in allowed_models() or reflection_lm not in allowed_models():
        raise ValueError("model_config contains an unconfigured model")
    budget = request_value(request, "budget", dict)
    max_metric_calls = budget.get("max_metric_calls")
    if not isinstance(max_metric_calls, int) or isinstance(max_metric_calls, bool) or not 1 <= max_metric_calls <= MAX_METRIC_CALLS:
        raise ValueError(f"budget.max_metric_calls must be between 1 and {MAX_METRIC_CALLS}")
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


def cli_mode_is_allowed():
    # This explicitly prevents a locally authenticated developer CLI in production.
    return os.environ.get("NODE_ENV") != "production" or os.environ.get("ASTRAEA_ALLOW_DEV_LLM_IN_PRODUCTION") == "true"


if sys.argv[1:] == ["--smoke"]:
    try:
        import gepa  # type: ignore
    except ImportError:
        sys.exit(2)
    print(json.dumps({"ready": True}))
    sys.exit(0)

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

if os.environ.get("GEPA_WORKER_MODE") == "cli":
    if not cli_mode_is_allowed():
        sys.stderr.write("GEPA_WORKER_MODE=cli is disabled when NODE_ENV=production")
        sys.exit(2)
    task_lm = task_lm_for_model(task_lm)
    reflection_lm = reflection_lm_for_model(reflection_lm)

try:
    import gepa  # type: ignore # Installed only in the isolated worker image.
    from gepa.adapters.default_adapter.default_adapter import DefaultAdapter
except ImportError:
    sys.stderr.write("GEPA is not installed in the worker environment")
    sys.exit(2)

try:
    adapter = DefaultAdapter(model=task_lm)
    result = gepa.optimize(
        seed_candidate={"system_prompt": source},
        trainset=trainset,
        valset=trainset,
        adapter=adapter,
        task_lm=None,
        reflection_lm=reflection_lm,
        max_metric_calls=max_metric_calls,
        logger=StderrLogger(),
    )
    candidate = result.best_candidate["system_prompt"]
    score = result.val_aggregate_scores[result.best_idx]
    print(json.dumps({"candidate": candidate, "score": score}))
except DevCliLlmError as error:
    sys.stderr.write(f"GEPA development CLI failed: {error}")
    sys.exit(1)
except Exception as error:
    sys.stderr.write(f"GEPA optimization failed: {error}")
    sys.exit(1)
