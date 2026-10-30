import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.dev_cli_llm import DevCliLlmError, run_dev_cli

PROVIDER_DISPATCH_KEY = "glasshouse:optimization:22222222-2222-4222-8222-222222222222:provider_dispatch:1"


def optimization_dataset(training_examples=None, validation_examples=None):
    return {
        "version": 1,
        "rubric": "Produce concise, accurate summaries that preserve the important task details.",
        "training_examples": training_examples
        or [{"input": "Training task", "answer": "Training expected answer"}],
        "validation_examples": validation_examples
        or [{"input": "Validation task", "answer": "Validation expected answer"}],
    }


def process_running(pid):
    try:
        # A container PID 1 may not reap terminated orphans. A zombie is dead,
        # not a live CLI descendant capable of making another provider call.
        return Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1][0] != "Z"
    except FileNotFoundError:
        return False


class DevCliLlmTests(unittest.TestCase):
    def fake_cli(self, directory):
        script = Path(directory) / "fake_cli.py"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, subprocess, sys, time\n"
            "mode = sys.argv[1]\n"
            "if mode == 'success': print(sys.stdin.read() + '|' + sys.argv[2])\n"
            "elif mode == 'timeout': time.sleep(10)\n"
            "elif mode == 'failure': sys.exit(7)\n"
            "elif mode == 'large': print('x' * 200)\n"
            "elif mode == 'argv': pathlib.Path(sys.argv[2]).write_text(repr(sys.argv[3:])); print(sys.stdin.read())\n"
            "elif mode == 'key': pathlib.Path(sys.argv[2]).write_text(os.environ.get('GLASSHOUSE_PROVIDER_DISPATCH_KEY', '')); print(sys.stdin.read())\n"
            "elif mode == 'timeout-child':\n"
            f"    child = subprocess.Popen([{sys.executable!r}, '-c', 'import time; time.sleep(10)'])\n"
            "    pathlib.Path(sys.argv[2]).write_text(str(child.pid)); time.sleep(10)\n"
            "elif mode == 'orphan-child':\n"
            f"    child = subprocess.Popen([{sys.executable!r}, '-c', 'import time; time.sleep(10)'])\n"
            "    pathlib.Path(sys.argv[2]).write_text(str(child.pid))\n"
        )
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        return script

    def test_success_substitutes_model_and_sends_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            with patch.dict(os.environ, {"GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "success", "{{model}}"]'}, clear=True):
                self.assertEqual(run_dev_cli("hello", "test-model"), "hello|test-model\n")

    def test_timeout_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            with patch.dict(os.environ, {"GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "timeout"]', "GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS": "1"}, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "timed out"):
                    run_dev_cli("hello", "model")

    def test_timeout_kills_children_holding_stdout_open(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            child_pid = Path(directory) / "child.pid"
            environment = {
                "GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "timeout-child", "{child_pid}"]',
                "GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS": "1",
            }
            started_at = time.monotonic()
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "timed out"):
                    run_dev_cli("hello", "model")
            self.assertLess(time.monotonic() - started_at, 3)
            pid = int(child_pid.read_text())
            for _ in range(20):
                if not process_running(pid):
                    break
                time.sleep(0.05)
            self.assertFalse(process_running(pid))

    def test_timeout_kills_child_when_cli_parent_exits_first(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            child_pid = Path(directory) / "child.pid"
            environment = {
                "GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "orphan-child", "{child_pid}"]',
                "GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS": "1",
            }
            started_at = time.monotonic()
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "timed out"):
                    run_dev_cli("hello", "model")
            self.assertLess(time.monotonic() - started_at, 3)
            pid = int(child_pid.read_text())
            for _ in range(20):
                if not process_running(pid):
                    break
                time.sleep(0.05)
            self.assertFalse(process_running(pid))

    def test_nonzero_exit_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            with patch.dict(os.environ, {"GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "failure"]'}, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "exited unsuccessfully"):
                    run_dev_cli("hello", "model")

    def test_output_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            environment = {"GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "large"]', "GLASSHOUSE_DEV_LLM_MAX_OUTPUT_BYTES": "100"}
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "size limit"):
                    run_dev_cli("hello", "model")

    def test_shell_metacharacters_are_not_interpreted(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            argv_file = Path(directory) / "argv.txt"
            command = f'["{cli}", "argv", "{argv_file}", "{{model}}"]'
            with patch.dict(os.environ, {"GLASSHOUSE_DEV_LLM_COMMAND": command}, clear=True):
                prompt = "$(touch should-not-exist); `whoami`; ; &"
                self.assertEqual(run_dev_cli(prompt, "model;$(touch nope)"), f"{prompt}\n")
            self.assertEqual(argv_file.read_text(), "['model;$(touch nope)']")
            self.assertFalse((Path(directory) / "should-not-exist").exists())

    def test_provider_dispatch_key_reaches_the_development_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            key_file = Path(directory) / "provider_dispatch_key.txt"
            with patch.dict(
                os.environ,
                {"GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "key", "{key_file}"]'},
                clear=True,
            ):
                self.assertEqual(
                    run_dev_cli("hello", "test-model", PROVIDER_DISPATCH_KEY),
                    "hello\n",
                )
            self.assertEqual(key_file.read_text(), PROVIDER_DISPATCH_KEY)

    def test_production_rejects_cli_mode_without_override(self):
        request = {
            "source": "Hello",
            "target": "system",
            "evaluator": {"type": "default_adapter"},
            "dataset": optimization_dataset(
                [{"input": "Hello", "answer": "Hello"}],
                [{"input": "Separate test", "answer": "Separate test"}],
            ),
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
            "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
            "budget": {"max_metric_calls": 2},
        }
        environment = {
            "GEPA_WORKER_MODE": "cli",
            "GEPA_ALLOWED_MODELS": "local-model",
            "NODE_ENV": "production",
        }
        worker = Path(__file__).with_name("gepa_worker.py")
        result = subprocess.run(
            [sys.executable, worker],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, "GEPA_WORKER_MODE=cli is disabled when NODE_ENV=production")

    def test_worker_rejects_material_train_validation_overlap(self):
        request = {
            "source": "Summarize {{tasks}}",
            "target": "system",
            "evaluator": {"type": "default_adapter"},
            "dataset": optimization_dataset(
                [{"input": "Please summarize today tasks", "answer": "Training label"}],
                [
                    {
                        "input": "Please summarize today tasks with dates",
                        "answer": "Held-out label",
                    }
                ],
            ),
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
            "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
            "budget": {"max_metric_calls": 2},
        }
        worker = Path(__file__).with_name("gepa_worker.py")
        result = subprocess.run(
            [sys.executable, worker],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            env={"GEPA_WORKER_MODE": "fake", "GEPA_ALLOWED_MODELS": "local-model"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("unique and non-overlapping", result.stderr)

    def test_worker_rejects_a_budget_smaller_than_held_out_validation(self):
        request = {
            "source": "Summarize {{tasks}}",
            "target": "system",
            "evaluator": {"type": "default_adapter"},
            "dataset": optimization_dataset(
                [{"input": "delta", "answer": "Training label"}],
                [
                    {"input": "alpha", "answer": "Held-out label"},
                    {"input": "bravo", "answer": "Held-out label"},
                    {"input": "charlie", "answer": "Held-out label"},
                ],
            ),
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
            "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
            "budget": {"max_metric_calls": 2},
        }
        worker = Path(__file__).with_name("gepa_worker.py")
        result = subprocess.run(
            [sys.executable, worker],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            env={"GEPA_WORKER_MODE": "fake", "GEPA_ALLOWED_MODELS": "local-model"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("at least the number of held-out validation examples", result.stderr)

    def test_worker_rejects_reordered_train_validation_overlap(self):
        request = {
            "source": "Summarize {{tasks}}",
            "target": "system",
            "evaluator": {"type": "default_adapter"},
            "dataset": optimization_dataset(
                [{"input": "order a salad with fries", "answer": "Training label"}],
                [{"input": "fries with a salad order", "answer": "Held-out label"}],
            ),
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
            "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
            "budget": {"max_metric_calls": 2},
        }
        worker = Path(__file__).with_name("gepa_worker.py")
        result = subprocess.run(
            [sys.executable, worker],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            env={"GEPA_WORKER_MODE": "fake", "GEPA_ALLOWED_MODELS": "local-model"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("unique and non-overlapping", result.stderr)

    def test_worker_rejects_near_duplicate_train_validation_overlap(self):
        training_input = " ".join(f"training{index}" for index in range(100))
        validation_input = " ".join(
            [*(f"training{index}" for index in range(79)), *(f"validation{index}" for index in range(21))]
        )
        request = {
            "source": "Summarize {{tasks}}",
            "target": "system",
            "evaluator": {"type": "default_adapter"},
            "dataset": optimization_dataset(
                [{"input": training_input, "answer": "Training label"}],
                [{"input": validation_input, "answer": "Held-out label"}],
            ),
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
            "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
            "budget": {"max_metric_calls": 2},
        }
        worker = Path(__file__).with_name("gepa_worker.py")
        result = subprocess.run(
            [sys.executable, worker],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            env={"GEPA_WORKER_MODE": "fake", "GEPA_ALLOWED_MODELS": "local-model"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("unique and non-overlapping", result.stderr)

    def test_worker_rejects_single_token_train_validation_containment(self):
        request = {
            "source": "Summarize {{tasks}}",
            "target": "system",
            "evaluator": {"type": "default_adapter"},
            "dataset": optimization_dataset(
                [{"input": "refund", "answer": "Training label"}],
                [{"input": "refund now", "answer": "Held-out label"}],
            ),
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
            "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
            "budget": {"max_metric_calls": 2},
        }
        worker = Path(__file__).with_name("gepa_worker.py")
        result = subprocess.run(
            [sys.executable, worker],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            env={"GEPA_WORKER_MODE": "fake", "GEPA_ALLOWED_MODELS": "local-model"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("unique and non-overlapping", result.stderr)

    def test_cli_mode_uses_held_out_validation_and_redacts_labels_from_reflection(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            gepa_directory = Path(directory) / "gepa"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            (gepa_directory / "__init__.py").write_text(
                "import os\n"
                "import sys\n"
                "from types import SimpleNamespace\n"
                "def optimize(*, adapter, task_lm, reflection_lm, seed_candidate, trainset, valset, callbacks, **kwargs):\n"
                "    assert adapter is not None\n"
                "    assert callable(adapter.model)\n"
                "    assert adapter.propose_new_texts is None\n"
                "    assert task_lm is None\n"
                "    assert callable(reflection_lm)\n"
                "    assert kwargs['track_best_outputs'] is False\n"
                "    assert trainset is not valset\n"
                "    assert 'quarterly status report' in trainset[0]['input']\n"
                "    assert 'customer renewal proposal' in valset[0]['input']\n"
                "    assert '{{tasks}}' in seed_candidate['system_prompt']\n"
                "    batch = SimpleNamespace(trajectories=[{'data': trainset[0], 'full_assistant_response': 'Finish and send the quarterly status report by 2:00 PM, then review and approve the API pull request.'}], scores=[0], outputs=[{}])\n"
                "    reflection = adapter.make_reflective_dataset(seed_candidate, batch, ['system_prompt'])\n"
                "    assert 'Finish and send the quarterly status report' not in repr(reflection)\n"
                "    assert 'Generated Outputs' not in reflection['system_prompt'][0]\n"
                "    held_out = adapter.evaluate(valset, {'system_prompt': 'Generalized daily-summary instructions for {{tasks}}'})\n"
                "    assert held_out.scores == [0.75]\n"
                "    assert 'customer renewal proposal' in held_out.outputs[0]['full_assistant_response']\n"
                "    assert 'quarterly status report' not in held_out.outputs[0]['full_assistant_response']\n"
                "    callbacks[0].on_budget_updated({'metric_calls_used': 1, 'metric_calls_delta': 1, 'metric_calls_remaining': 4})\n"
                "    kwargs[\"logger\"].log(\"candidate: very sensitive prompt text\")\n"
                "    os.write(2, b\"provider payload: very sensitive prompt text\\n\")\n"
                "    assert reflection_lm(\"reflection\")\n"
                "    return SimpleNamespace(best_candidate={'system_prompt': 'Generalized daily-summary instructions for {{tasks}}'}, best_idx=1, val_aggregate_scores=[0.25, 0.75], total_metric_calls=3)\n"
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "import os\n"
                "import sys\n"
                "from types import SimpleNamespace\n"
                "class DefaultAdapter:\n"
                "    def __init__(self, model):\n"
                "        self.model = model\n"
                "    def evaluate(self, batch, candidate, capture_traces=False):\n"
                "        assert '{{tasks}}' in candidate['system_prompt']\n"
                "        outputs = []\n"
                "        scores = []\n"
                "        for data in batch:\n"
                "            if 'quarterly status report' in data['input']:\n"
                "                os.write(1, b'training stdout sentinel')\n"
                "                os.write(2, b'training stderr sentinel')\n"
                "            if 'customer renewal proposal' in data['input']:\n"
                "                outputs.append({'full_assistant_response': '**Before noon:** Send the customer renewal proposal before 11:00 AM. **This afternoon:** Prepare notes for the 3:00 PM planning meeting. **Later:** Refill the prescription and water the plants.'})\n"
                "                scores.append(0.75)\n"
                "            else:\n"
                "                outputs.append({'full_assistant_response': 'Generalized training summary'})\n"
                "                scores.append(0.5)\n"
                "        return type('Evaluation', (), {'scores': scores, 'outputs': outputs})()\n"
            )
            training_answer = (
                "**Today's priorities:** Finish and send the quarterly status report by 2:00 PM, "
                "then review and approve the API pull request.  \n**After work:** Pick up groceries, "
                "schedule a dental cleaning, and take the dog for a 30-minute walk."
            )
            held_out_answer = (
                "**Before noon:** Send the customer renewal proposal before 11:00 AM.\n"
                "**This afternoon:** Prepare notes for the 3:00 PM planning meeting.\n"
                "**Later:** Refill the prescription on the way home and water the plants tonight."
            )
            request = {
                "source": "Summarize {{tasks}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [
                        {
                            "input": "Finish the quarterly status report and send it to the team by 2:00 PM; review the API pull request; pick up groceries; call the dentist; walk the dog.",
                            "answer": training_answer,
                        }
                    ],
                    [
                        {
                            "input": "Send the customer renewal proposal before 11:00 AM; prepare notes for the 3:00 PM planning meeting; refill the prescription; water the plants.",
                            "answer": held_out_answer,
                        }
                    ],
                ),
                "model_config": {"task_lm": "task-model", "reflection_lm": "reflection-model"},
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 5},
            }
            environment = {
                "GEPA_WORKER_MODE": "cli",
                "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                "GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "success", "{{model}}"]',
                "NODE_ENV": "production",
                "GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION": "true",
                "PYTHONPATH": directory,
            }
            worker = Path(__file__).with_name("gepa_worker.py")
            result = subprocess.run(
                [sys.executable, worker],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env=environment,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(
                output,
                {
                    "candidate": "Generalized daily-summary instructions for {{tasks}}",
                    "training_score": 0.5,
                    "validation_score": 0.75,
                    "baseline_validation_score": 0.25,
                    "metric_calls_used": 2,
                },
            )
            self.assertNotIn(training_answer, output["candidate"])
            self.assertNotIn(held_out_answer, output["candidate"])
            self.assertIn('GLASSHOUSE_GEPA_PROGRESS {"metric_calls_used": 1}', result.stderr)
            self.assertNotIn("very sensitive prompt text", result.stderr)
            self.assertNotIn("training stdout sentinel", result.stdout)
            self.assertNotIn("training stderr sentinel", result.stderr)
            self.assertTrue(
                all(
                    line.startswith("GLASSHOUSE_GEPA_PROGRESS ")
                    for line in result.stderr.splitlines()
                    if line
                )
            )

    def test_litellm_calls_use_distinct_stable_provider_dispatch_sequences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gepa_directory = root / "gepa"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            capture_file = root / "litellm-calls.jsonl"
            (root / "litellm.py").write_text(
                "import json, os\n"
                "from types import SimpleNamespace\n"
                "def completion(**kwargs):\n"
                "    with open(os.environ['LITELLM_CAPTURE'], 'a', encoding='utf-8') as capture:\n"
                "        capture.write(json.dumps({'headers': kwargs['custom_headers'], 'request_id': kwargs['request_id'], 'num_retries': kwargs['num_retries']}) + '\\n')\n"
                "    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='expected answer'))])\n"
            )
            (gepa_directory / "__init__.py").write_text(
                "from types import SimpleNamespace\n"
                "def optimize(*, adapter, trainset, valset, reflection_lm, **kwargs):\n"
                "    adapter.evaluate(valset, {'system_prompt': 'candidate'})\n"
                "    reflection_lm('reflection')\n"
                "    return SimpleNamespace(best_candidate={'system_prompt': 'candidate'}, best_idx=1, val_aggregate_scores=[0.25, 0.75])\n"
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "class DefaultAdapter:\n"
                "    def __init__(self, model): self.model = model\n"
                "    def evaluate(self, batch, candidate, capture_traces=False):\n"
                "        outputs = []\n"
                "        trajectories = []\n"
                "        for data in batch:\n"
                "            response = self.model([{'role': 'user', 'content': data['input']}])\n"
                "            outputs.append({'full_assistant_response': response})\n"
                "            trajectories.append({'data': data})\n"
                "        return type('Evaluation', (), {'scores': [1.0] * len(batch), 'outputs': outputs, 'trajectories': trajectories})()\n"
            )
            request = {
                "source": "Summarize {{tasks}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [{"input": "training task", "answer": "expected answer"}],
                    [{"input": "validation task", "answer": "expected answer"}],
                ),
                "model_config": {"task_lm": "task-model", "reflection_lm": "reflection-model"},
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 2},
            }
            result = subprocess.run(
                [sys.executable, Path(__file__).with_name("gepa_worker.py")],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                    "PYTHONPATH": directory,
                    "LITELLM_CAPTURE": str(capture_file),
                },
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [json.loads(line) for line in capture_file.read_text().splitlines()]
            self.assertEqual(
                [call["request_id"] for call in calls],
                [
                    PROVIDER_DISPATCH_KEY + ":task:1",
                    PROVIDER_DISPATCH_KEY + ":reflection:2",
                    PROVIDER_DISPATCH_KEY + ":task:3",
                ],
            )
            for call in calls:
                self.assertEqual(call["headers"]["Idempotency-Key"], call["request_id"])
                self.assertEqual(call["headers"]["X-Client-Request-Id"], call["request_id"])
                self.assertEqual(call["num_retries"], 0)

    def test_cli_mode_omits_training_score_when_it_exceeds_remaining_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            gepa_directory = Path(directory) / "gepa"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            (gepa_directory / "__init__.py").write_text(
                "from types import SimpleNamespace\n"
                "def optimize(*, adapter, trainset, valset, **kwargs):\n"
                "    adapter.evaluate(valset, {'system_prompt': 'candidate'})\n"
                "    return SimpleNamespace(best_candidate={'system_prompt': 'candidate'}, best_idx=1, val_aggregate_scores=[0.25, 0.75], total_metric_calls=1)\n"
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "class DefaultAdapter:\n"
                "    def __init__(self, model): self.model = model\n"
                "    def evaluate(self, batch, candidate, capture_traces=False):\n"
                "        return type('Evaluation', (), {'scores': [0.75] * len(batch), 'outputs': [{}] * len(batch)})()\n"
            )
            request = {
                "source": "Summarize {{tasks}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [
                        {"input": "training task one", "answer": "Training answer one"},
                        {"input": "training task two", "answer": "Training answer two"},
                    ],
                    [{"input": "validation task", "answer": "Validation answer"}],
                ),
                "model_config": {"task_lm": "task-model", "reflection_lm": "reflection-model"},
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 2},
            }
            worker = Path(__file__).with_name("gepa_worker.py")
            result = subprocess.run(
                [sys.executable, worker],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    "GEPA_WORKER_MODE": "cli",
                    "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                    "PYTHONPATH": directory,
                },
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                {
                    "candidate": "candidate",
                    "training_score": None,
                    "validation_score": 0.75,
                    "baseline_validation_score": 0.25,
                    "metric_calls_used": 1,
                },
            )

    def test_worker_reports_a_safe_optimization_exception_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            gepa_directory = Path(directory) / "gepa"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            (gepa_directory / "__init__.py").write_text(
                "def optimize(**kwargs):\n"
                "    raise RuntimeError('provider token must not be logged')\n"
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "class DefaultAdapter:\n"
                "    def __init__(self, model): self.model = model\n"
            )
            request = {
                "source": "Answer {{item}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [{"input": "training input", "answer": "expected answer"}],
                    [{"input": "heldout input", "answer": "expected answer"}],
                ),
                "model_config": {
                    "task_lm": "task-model",
                    "reflection_lm": "reflection-model",
                },
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 2},
            }
            result = subprocess.run(
                [sys.executable, Path(__file__).with_name("gepa_worker.py")],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    "GEPA_WORKER_MODE": "cli",
                    "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                    "PYTHONPATH": directory,
                },
                check=False,
            )

        self.assertEqual(result.returncode, 1)
        self.assertRegex(
            result.stderr,
            r"GLASSHOUSE_GEPA_FAILURE RuntimeError gepa:[1-9][0-9]*$",
        )
        self.assertNotIn("provider token", result.stderr)

    def test_worker_reports_a_safe_failure_site_for_a_type_error(self):
        with tempfile.TemporaryDirectory() as directory:
            gepa_directory = Path(directory) / "gepa"
            gepa_metadata_directory = Path(directory) / "gepa-0.1.4.dist-info"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            gepa_metadata_directory.mkdir()
            (gepa_metadata_directory / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: gepa\nVersion: 0.1.4\n"
            )
            (gepa_directory / "__init__.py").write_text(
                "def optimize(**kwargs):\n"
                "    raise TypeError('provider token must not be logged')\n"
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "class DefaultAdapter:\n"
                "    def __init__(self, model): self.model = model\n"
            )
            request = {
                "source": "Answer {{item}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [{"input": "training input", "answer": "expected answer"}],
                    [{"input": "heldout input", "answer": "expected answer"}],
                ),
                "model_config": {
                    "task_lm": "task-model",
                    "reflection_lm": "reflection-model",
                },
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 2},
            }
            result = subprocess.run(
                [sys.executable, Path(__file__).with_name("gepa_worker.py")],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    "GEPA_WORKER_MODE": "cli",
                    "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                    "PYTHONPATH": directory,
                },
                check=False,
            )

        self.assertEqual(result.returncode, 1)
        self.assertRegex(
            result.stderr,
            r"GLASSHOUSE_GEPA_RUNTIME 0\.1\.4\nGLASSHOUSE_GEPA_FAILURE TypeError gepa:[1-9][0-9]*$",
        )
        self.assertNotIn("provider token", result.stderr)

    def test_worker_does_not_emit_an_arbitrary_exception_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            gepa_directory = Path(directory) / "gepa"
            malformed_gepa_metadata_directory = Path(directory) / "gepa-invalid.dist-info"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            malformed_gepa_metadata_directory.mkdir()
            (malformed_gepa_metadata_directory / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: gepa\n"
            )
            (gepa_directory / "__init__.py").write_text(
                "def optimize(**kwargs):\n"
                '    exec(compile("raise TypeError(\'untrusted filename must not leak\')", "provider-token.py", "exec"))\n'
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "class DefaultAdapter:\n"
                "    def __init__(self, model): self.model = model\n"
            )
            request = {
                "source": "Answer {{item}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [{"input": "training input", "answer": "expected answer"}],
                    [{"input": "heldout input", "answer": "expected answer"}],
                ),
                "model_config": {
                    "task_lm": "task-model",
                    "reflection_lm": "reflection-model",
                },
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 2},
            }
            result = subprocess.run(
                [sys.executable, Path(__file__).with_name("gepa_worker.py")],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    "GEPA_WORKER_MODE": "cli",
                    "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                    "PYTHONPATH": directory,
                },
                check=False,
            )

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stderr, "GLASSHOUSE_GEPA_FAILURE TypeError")
        self.assertNotIn("provider-token", result.stderr)

    def test_real_gepa_minimum_dataset_stops_within_metric_budget(self):
        runtime = os.environ.get("GEPA_PYTHON", sys.executable)
        installed = subprocess.run(
            [
                runtime,
                "-c",
                "import importlib.metadata; assert importlib.metadata.version('gepa') == '0.1.4'",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        if installed.returncode:
            self.skipTest("requires the pinned gepa==0.1.4 worker runtime")

        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / "fake_gepa_cli.py"
            cli.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "model = sys.argv[1]\n"
                "prompt = sys.stdin.read()\n"
                "if model == 'task-model':\n"
                "    print('expected answer' if 'Optimized {{item}}' in prompt else 'incorrect')\n"
                "else:\n"
                "    print('```Optimized {{item}}```')\n"
            )
            cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
            request = {
                "source": "Answer {{item}}",
                "target": "system",
                "evaluator": {"type": "default_adapter"},
                "dataset": optimization_dataset(
                    [{"input": "training input", "answer": "expected answer"}],
                    [{"input": "heldout input", "answer": "expected answer"}],
                ),
                "model_config": {
                    "task_lm": "task-model",
                    "reflection_lm": "reflection-model",
                },
                "provider_dispatch_key": PROVIDER_DISPATCH_KEY,
                "budget": {"max_metric_calls": 3},
            }
            result = subprocess.run(
                [runtime, Path(__file__).with_name("gepa_worker.py")],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "GEPA_WORKER_MODE": "cli",
                    "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                    "GLASSHOUSE_DEV_LLM_COMMAND": f'["{cli}", "{{model}}"]',
                    "NODE_ENV": "production",
                    "GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION": "true",
                },
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertIsInstance(output["candidate"], str)
        self.assertLessEqual(output["metric_calls_used"], 3)
        self.assertLessEqual(
            max(
                [
                    json.loads(line.removeprefix("GLASSHOUSE_GEPA_PROGRESS "))[
                        "metric_calls_used"
                    ]
                    for line in result.stderr.splitlines()
                    if line.startswith("GLASSHOUSE_GEPA_PROGRESS ")
                ],
                default=0,
            ),
            3,
        )


if __name__ == "__main__":
    unittest.main()
