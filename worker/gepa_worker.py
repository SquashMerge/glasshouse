#!/usr/bin/env python3
"""JSON-lines boundary for the optional GEPA runtime; credentials stay outside Astraea."""
import json
import math
import os
import re
import sys
import unicodedata

if __package__:
    from .dev_cli_llm import DevCliLlmError, reflection_lm_for_model, task_lm_for_model
else:
    from dev_cli_llm import DevCliLlmError, reflection_lm_for_model, task_lm_for_model

MAX_METRIC_CALLS = 100
MIN_METRIC_CALLS = 2
DEFAULT_IGNORABLE_RANGES = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)


class StderrLogger:
    """Keep GEPA progress off stdout, which is the worker's JSON protocol."""

    def log(self, message):
        print(message, file=sys.stderr, flush=True)

    def progress(self, metric_calls_used):
        print(
            "ASTRAEA_GEPA_PROGRESS " + json.dumps({"metric_calls_used": metric_calls_used}),
            file=sys.stderr,
            flush=True,
        )


class ProgressReportingAdapter:
    def __init__(self, base_adapter, logger):
        self._base_adapter = base_adapter
        self._logger = logger
        self.model = base_adapter.model
        self.propose_new_texts = getattr(base_adapter, "propose_new_texts", None)
        self.metric_calls_used = 0

    def evaluate(self, *args, **kwargs):
        evaluation = self._base_adapter.evaluate(*args, **kwargs)
        self.metric_calls_used += len(evaluation.scores)
        self._logger.progress(self.metric_calls_used)
        return evaluation

    def make_reflective_dataset(self, *args, **kwargs):
        return self._base_adapter.make_reflective_dataset(*args, **kwargs)


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


def normalize_input(value):
    normalized = unicodedata.normalize("NFKD", value).lower()
    visible = "".join(
        character
        for character in normalized
        if unicodedata.category(character) not in {"Cc", "Cf", "Mn", "Mc", "Me"}
        and not any(start <= ord(character) <= end for start, end in DEFAULT_IGNORABLE_RANGES)
    )
    return re.sub(r"\s+", " ", visible.strip())


def inputs_materially_overlap(left, right):
    if left == right:
        return True
    left_tokens = re.findall(r"[^\W_]+", left, flags=re.UNICODE)
    right_tokens = re.findall(r"[^\W_]+", right, flags=re.UNICODE)
    shorter, longer = (
        (left_tokens, right_tokens)
        if len(left_tokens) <= len(right_tokens)
        else (right_tokens, left_tokens)
    )
    if not shorter:
        return False
    if f" {' '.join(shorter)} " in f" {' '.join(longer)} ":
        return True
    longer_counts = {}
    for token in longer:
        longer_counts[token] = longer_counts.get(token, 0) + 1
    shared = 0
    for token in shorter:
        remaining = longer_counts.get(token, 0)
        if remaining == 0:
            continue
        shared += 1
        longer_counts[token] = remaining - 1
    return shared / len(shorter) >= 0.7


def examples(dataset, name):
    values = dataset.get(name)
    if not isinstance(values, list) or not values or not all(
        isinstance(example, dict)
        and isinstance(example.get("input"), str)
        and example["input"].strip()
        and isinstance(example.get("answer"), str)
        and example["answer"].strip()
        and (
            example.get("additional_context") is None
            or isinstance(example.get("additional_context"), dict)
        )
        for example in values
    ):
        raise ValueError(f"dataset.{name} must contain input and answer strings")
    return [
        {
            "input": example["input"],
            "answer": example["answer"],
            "additional_context": example.get("additional_context", {}),
        }
        for example in values
    ]


def validate_request(request):
    source = request_value(request, "source", str)
    target = request_value(request, "target", str)
    if target not in {"system", "user"}:
        raise ValueError("target must be system or user")
    evaluator = request_value(request, "evaluator", dict)
    if evaluator != {"type": "default_adapter"}:
        raise ValueError("evaluator must be the default_adapter")
    dataset = request_value(request, "dataset", dict)
    if dataset.get("version") != 1:
        raise ValueError("dataset.version must be 1")
    rubric = dataset.get("rubric")
    if not isinstance(rubric, str) or not rubric.strip():
        raise ValueError("dataset.rubric is required")
    trainset = examples(dataset, "training_examples")
    valset = examples(dataset, "validation_examples")
    training_inputs = [normalize_input(example["input"]) for example in trainset]
    validation_inputs = [normalize_input(example["input"]) for example in valset]
    inputs = training_inputs + validation_inputs
    if any(
        inputs_materially_overlap(inputs[index], prior)
        for index in range(len(inputs))
        for prior in inputs[:index]
    ):
        raise ValueError("training and validation examples must be unique and non-overlapping")
    model_config = request_value(request, "model_config", dict)
    task_lm = model_config.get("task_lm")
    reflection_lm = model_config.get("reflection_lm")
    if not isinstance(task_lm, str) or not isinstance(reflection_lm, str):
        raise ValueError("model_config requires task_lm and reflection_lm")
    if task_lm not in allowed_models() or reflection_lm not in allowed_models():
        raise ValueError("model_config contains an unconfigured model")
    budget = request_value(request, "budget", dict)
    max_metric_calls = budget.get("max_metric_calls")
    if not isinstance(max_metric_calls, int) or isinstance(max_metric_calls, bool) or not MIN_METRIC_CALLS <= max_metric_calls <= MAX_METRIC_CALLS:
        raise ValueError(f"budget.max_metric_calls must be between {MIN_METRIC_CALLS} and {MAX_METRIC_CALLS}")
    return source, rubric.strip(), trainset, valset, task_lm, reflection_lm, max_metric_calls


def fake_optimize(source):
    return {
        "candidate": source + "\n\nOptimize for clear, accurate answers.",
        "training_score": 1.0,
        "validation_score": 1.0,
        "baseline_validation_score": 0.0,
        "metric_calls_used": 0,
    }


def metric_calls_used(result):
    value = getattr(result, "total_metric_calls", None)
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def cli_mode_is_allowed():
    # This explicitly prevents a locally authenticated developer CLI in production.
    return os.environ.get("NODE_ENV") != "production" or os.environ.get("ASTRAEA_ALLOW_DEV_LLM_IN_PRODUCTION") == "true"


def average(scores, name):
    if not scores or not all(isinstance(score, (int, float)) and math.isfinite(score) for score in scores):
        raise ValueError(f"GEPA returned invalid {name}")
    return sum(scores) / len(scores)


if sys.argv[1:] == ["--smoke"]:
    try:
        import gepa  # type: ignore
    except ImportError:
        sys.exit(2)
    print(json.dumps({"ready": True}))
    sys.exit(0)

try:
    request = json.loads(sys.stdin.readline())
    source, rubric, trainset, valset, task_lm, reflection_lm, max_metric_calls = validate_request(request)
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


class AstraeaDefaultAdapter(DefaultAdapter):
    """Use labels for scoring only; reflection sees generalized feedback, never labels."""

    def __init__(self, model, rubric):
        super().__init__(model=model)
        self.rubric = rubric

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        if len(components_to_update) != 1:
            raise ValueError("GEPA must update one prompt component at a time")
        component = components_to_update[0]
        items = []
        for trajectory, score_value, _ in zip(
            eval_batch.trajectories,
            eval_batch.scores,
            eval_batch.outputs,
            strict=False,
        ):
            data = trajectory["data"]
            outcome = "met" if score_value > 0.0 else "did not meet"
            items.append(
                {
                    "Inputs": data["input"],
                    "Feedback": (
                        f"The generated response {outcome} the evaluation label. "
                        f"Improve generalized instructions using this objective:\n{self.rubric}\n"
                        "Do not copy example inputs or evaluation labels into the candidate prompt."
                    ),
                }
            )
        if not items:
            raise ValueError("GEPA produced no reflective examples")
        return {component: items}


try:
    logger = StderrLogger()
    adapter = ProgressReportingAdapter(AstraeaDefaultAdapter(model=task_lm, rubric=rubric), logger)
    result = gepa.optimize(
        seed_candidate={"system_prompt": source},
        trainset=trainset,
        valset=valset,
        adapter=adapter,
        task_lm=None,
        reflection_lm=reflection_lm,
        max_metric_calls=max_metric_calls,
        logger=logger,
    )
    best_idx = result.best_idx
    candidate = result.best_candidate["system_prompt"]
    validation_score = average([result.val_aggregate_scores[best_idx]], "validation score")
    baseline_validation_score = average([result.val_aggregate_scores[0]], "baseline validation score")
    training_score = average(
        adapter.evaluate(trainset, {"system_prompt": candidate}).scores,
        "training score",
    )
    print(
        json.dumps(
            {
                "candidate": candidate,
                "training_score": training_score,
                "validation_score": validation_score,
                "baseline_validation_score": baseline_validation_score,
                "metric_calls_used": metric_calls_used(result),
            }
        )
    )
except DevCliLlmError as error:
    sys.stderr.write(f"GEPA development CLI failed: {error}")
    sys.exit(1)
except Exception as error:
    sys.stderr.write(f"GEPA optimization failed: {error}")
    sys.exit(1)
