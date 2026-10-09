#!/usr/bin/env python3
"""JSON-lines boundary for the optional GEPA runtime; credentials stay outside Glasshouse."""
import json
import math
import os
import re
import sys
import traceback
import unicodedata
from importlib.metadata import version as distribution_version

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

    def __init__(self, stream):
        self._stream = stream

    def log(self, _message):
        # GEPA's free-form messages can contain candidates, examples, and provider output.
        return None

    def progress(self, metric_calls_used):
        print(
            "GLASSHOUSE_GEPA_PROGRESS " + json.dumps({"metric_calls_used": metric_calls_used}),
            file=self._stream,
            flush=True,
        )


class GepaBudgetProgressCallback:
    def __init__(self, logger):
        self._logger = logger
        self._last_metric_calls_used = 0

    def on_budget_updated(self, event):
        metric_calls_used = event.get("metric_calls_used")
        if (
            isinstance(metric_calls_used, int)
            and not isinstance(metric_calls_used, bool)
            and metric_calls_used > self._last_metric_calls_used
        ):
            self._last_metric_calls_used = metric_calls_used
            self._logger.progress(metric_calls_used)


class SuppressThirdPartyOutput:
    """Redirect both Python- and fd-level third-party output to /dev/null."""

    def __enter__(self):
        self._stdout = os.dup(1)
        self._stderr = os.dup(2)
        null = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(null, 1)
            os.dup2(null, 2)
        finally:
            os.close(null)

    def __exit__(self, _exc_type, _exc_value, _traceback):
        try:
            os.dup2(self._stdout, 1)
            os.dup2(self._stderr, 2)
        finally:
            os.close(self._stdout)
            os.close(self._stderr)


class ProgressReportingAdapter:
    def __init__(self, base_adapter, logger, max_metric_calls):
        self._base_adapter = base_adapter
        self._logger = logger
        self._max_metric_calls = max_metric_calls
        self.model = base_adapter.model
        self.propose_new_texts = getattr(base_adapter, "propose_new_texts", None)
        self.metric_calls_used = 0

    def evaluate(self, *args, **kwargs):
        metric_calls = len(args[0])
        if metric_calls > self.remaining_metric_calls:
            raise ValueError("GEPA evaluation would exceed the metric-call budget")
        evaluation = self._base_adapter.evaluate(*args, **kwargs)
        self.metric_calls_used += metric_calls
        self._logger.progress(self.metric_calls_used)
        return evaluation


    @property
    def remaining_metric_calls(self):
        return self._max_metric_calls - self.metric_calls_used

    def make_reflective_dataset(self, *args, **kwargs):
        return self._base_adapter.make_reflective_dataset(*args, **kwargs)


class RemainingMetricCallsStopper:
    def __init__(self, adapter, reflection_minibatch_size, validation_size):
        self._adapter = adapter
        self._minimum_iteration_calls = 2 * reflection_minibatch_size + validation_size

    def __call__(self, _state):
        return self._adapter.remaining_metric_calls < self._minimum_iteration_calls


SAFE_OPTIMIZATION_FAILURE_KINDS = {
    "AssertionError",
    "AttributeError",
    "KeyError",
    "RuntimeError",
    "TypeError",
    "ValueError",
}


def safe_gepa_runtime_version():
    try:
        value = distribution_version("gepa")
    except Exception:
        return None
    if not isinstance(value, str):
        return None
    return value if re.fullmatch(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}", value) else None


def safe_optimization_failure_kind(error):
    kind = type(error).__name__
    return kind if kind in SAFE_OPTIMIZATION_FAILURE_KINDS else "UnknownError"


def safe_optimization_failure_site(error):
    frames = traceback.extract_tb(error.__traceback__)
    if not frames:
        return None
    frame = frames[-1]
    if frame.lineno < 1:
        return None
    filename = os.path.realpath(frame.filename)
    worker_directory = os.path.realpath(os.path.dirname(__file__))
    if filename.startswith(f"{worker_directory}{os.sep}"):
        return f"glasshouse_worker:{frame.lineno}"
    if "gepa" in filename.split(os.sep):
        return f"gepa:{frame.lineno}"
    return None


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
    if target != "system":
        raise ValueError("target must be system")
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
    if max_metric_calls < len(valset):
        raise ValueError("budget.max_metric_calls must be at least the number of held-out validation examples")
    provider_dispatch_key = request_value(request, "provider_dispatch_key", str)
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,256}", provider_dispatch_key):
        raise ValueError("provider_dispatch_key is invalid")
    return source, rubric.strip(), trainset, valset, task_lm, reflection_lm, max_metric_calls, provider_dispatch_key


def fake_optimize(source):
    return {
        "candidate": source + "\n\nOptimize for clear, accurate answers.",
        "training_score": 1.0,
        "validation_score": 1.0,
        "baseline_validation_score": 0.0,
        "metric_calls_used": 0,
    }


class ProviderDispatchSequence:
    def __init__(self, dispatch_key):
        self._dispatch_key = dispatch_key
        self._operation = 0

    def next(self, role):
        self._operation += 1
        return f"{self._dispatch_key}:{role}:{self._operation}"


def litellm_model_for_dispatch(model, dispatches, role):
    import litellm  # type: ignore # Installed only in the isolated worker image.

    def complete(messages):
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        key = dispatches.next(role)
        response = litellm.completion(
            model=model,
            messages=messages,
            custom_headers={
                "Idempotency-Key": key,
                "X-Client-Request-Id": key,
            },
            request_id=key,
            num_retries=0,
        )
        content = response.choices[0].message.content
        if not isinstance(content, str):
            raise ValueError("LiteLLM returned invalid content")
        return content

    return complete


def cli_mode_is_allowed():
    # This explicitly prevents a locally authenticated developer CLI in production.
    return os.environ.get("NODE_ENV") != "production" or os.environ.get("GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION") == "true"


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
    source, rubric, trainset, valset, task_lm, reflection_lm, max_metric_calls, provider_dispatch_key = validate_request(request)
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
    dispatches = ProviderDispatchSequence(provider_dispatch_key)
    task_lm = task_lm_for_model(task_lm, lambda: dispatches.next("task"))
    reflection_lm = reflection_lm_for_model(reflection_lm, lambda: dispatches.next("reflection"))
else:
    dispatches = ProviderDispatchSequence(provider_dispatch_key)
    task_lm = litellm_model_for_dispatch(task_lm, dispatches, "task")
    reflection_lm = litellm_model_for_dispatch(reflection_lm, dispatches, "reflection")

try:
    import gepa  # type: ignore # Installed only in the isolated worker image.
    from gepa.adapters.default_adapter.default_adapter import DefaultAdapter
except ImportError:
    sys.stderr.write("GEPA is not installed in the worker environment")
    sys.exit(2)


class GlasshouseDefaultAdapter(DefaultAdapter):
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
    progress_stream = os.fdopen(
        os.dup(2), "w", encoding=sys.stderr.encoding or "utf-8", buffering=1
    )
    logger = StderrLogger(progress_stream)
    adapter = ProgressReportingAdapter(
        GlasshouseDefaultAdapter(model=task_lm, rubric=rubric), logger, max_metric_calls
    )
    reflection_minibatch_size = min(3, len(trainset))
    with SuppressThirdPartyOutput():
        result = gepa.optimize(
            seed_candidate={"system_prompt": source},
            trainset=trainset,
            valset=valset,
            adapter=adapter,
            task_lm=None,
            reflection_lm=reflection_lm,
            max_metric_calls=max_metric_calls,
            reflection_minibatch_size=reflection_minibatch_size,
            stop_callbacks=RemainingMetricCallsStopper(
                adapter, reflection_minibatch_size, len(valset)
            ),
            callbacks=[GepaBudgetProgressCallback(logger)],
            track_best_outputs=False,
            logger=logger,
        )
    best_idx = result.best_idx
    candidate = result.best_candidate["system_prompt"]
    validation_score = average([result.val_aggregate_scores[best_idx]], "validation score")
    baseline_validation_score = average([result.val_aggregate_scores[0]], "baseline validation score")
    if len(trainset) <= adapter.remaining_metric_calls:
        with SuppressThirdPartyOutput():
            training_score = average(
                adapter.evaluate(trainset, {"system_prompt": candidate}).scores,
                "training score",
            )
    else:
        training_score = None
    print(
        json.dumps(
            {
                "candidate": candidate,
                "training_score": training_score,
                "validation_score": validation_score,
                "baseline_validation_score": baseline_validation_score,
                "metric_calls_used": adapter.metric_calls_used,
            }
        )
    )
except DevCliLlmError:
    sys.stderr.write("GEPA development CLI failed")
    sys.exit(1)
except Exception as error:
    kind = safe_optimization_failure_kind(error)
    site = safe_optimization_failure_site(error)
    runtime_version = safe_gepa_runtime_version()
    if runtime_version:
        sys.stderr.write(f"GLASSHOUSE_GEPA_RUNTIME {runtime_version}\n")
    sys.stderr.write(
        f"GLASSHOUSE_GEPA_FAILURE {kind}" + (f" {site}" if site else "")
    )
    sys.exit(1)
