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


class DevCliLlmTests(unittest.TestCase):
    def fake_cli(self, directory):
        script = Path(directory) / "fake_cli.py"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import pathlib, subprocess, sys, time\n"
            "mode = sys.argv[1]\n"
            "if mode == 'success': print(sys.stdin.read() + '|' + sys.argv[2])\n"
            "elif mode == 'timeout': time.sleep(10)\n"
            "elif mode == 'failure': sys.exit(7)\n"
            "elif mode == 'large': print('x' * 200)\n"
            "elif mode == 'argv': pathlib.Path(sys.argv[2]).write_text(repr(sys.argv[3:])); print(sys.stdin.read())\n"
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
            with patch.dict(os.environ, {"ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "success", "{{model}}"]'}, clear=True):
                self.assertEqual(run_dev_cli("hello", "test-model"), "hello|test-model\n")

    def test_timeout_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            with patch.dict(os.environ, {"ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "timeout"]', "ASTRAEA_DEV_LLM_TIMEOUT_SECONDS": "1"}, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "timed out"):
                    run_dev_cli("hello", "model")

    def test_timeout_kills_children_holding_stdout_open(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            child_pid = Path(directory) / "child.pid"
            environment = {
                "ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "timeout-child", "{child_pid}"]',
                "ASTRAEA_DEV_LLM_TIMEOUT_SECONDS": "1",
            }
            started_at = time.monotonic()
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "timed out"):
                    run_dev_cli("hello", "model")
            self.assertLess(time.monotonic() - started_at, 3)
            pid = int(child_pid.read_text())
            for _ in range(20):
                if not Path(f"/proc/{pid}").exists():
                    break
                time.sleep(0.05)
            self.assertFalse(Path(f"/proc/{pid}").exists())

    def test_timeout_kills_child_when_cli_parent_exits_first(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            child_pid = Path(directory) / "child.pid"
            environment = {
                "ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "orphan-child", "{child_pid}"]',
                "ASTRAEA_DEV_LLM_TIMEOUT_SECONDS": "1",
            }
            started_at = time.monotonic()
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "timed out"):
                    run_dev_cli("hello", "model")
            self.assertLess(time.monotonic() - started_at, 3)
            pid = int(child_pid.read_text())
            for _ in range(20):
                if not Path(f"/proc/{pid}").exists():
                    break
                time.sleep(0.05)
            self.assertFalse(Path(f"/proc/{pid}").exists())

    def test_nonzero_exit_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            with patch.dict(os.environ, {"ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "failure"]'}, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "exited unsuccessfully"):
                    run_dev_cli("hello", "model")

    def test_output_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            environment = {"ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "large"]', "ASTRAEA_DEV_LLM_MAX_OUTPUT_BYTES": "100"}
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(DevCliLlmError, "size limit"):
                    run_dev_cli("hello", "model")

    def test_shell_metacharacters_are_not_interpreted(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            argv_file = Path(directory) / "argv.txt"
            command = f'["{cli}", "argv", "{argv_file}", "{{model}}"]'
            with patch.dict(os.environ, {"ASTRAEA_DEV_LLM_COMMAND": command}, clear=True):
                prompt = "$(touch should-not-exist); `whoami`; ; &"
                self.assertEqual(run_dev_cli(prompt, "model;$(touch nope)"), f"{prompt}\n")
            self.assertEqual(argv_file.read_text(), "['model;$(touch nope)']")
            self.assertFalse((Path(directory) / "should-not-exist").exists())

    def test_production_rejects_cli_mode_without_override(self):
        request = {
            "source": "Hello",
            "evaluator": {"type": "default_adapter"},
            "examples": [{"input": "Hello", "answer": "Hello"}],
            "model_config": {"task_lm": "local-model", "reflection_lm": "local-model"},
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

    def test_reflection_feedback_keeps_reference_answers_out_of_reusable_instructions(self):
        from worker.gepa_feedback import build_reflective_feedback

        feedback = build_reflective_feedback(
            {"input": "Task list", "answer": "Only this example answer"},
            "A different response",
            0.0,
        )

        self.assertIn("evaluation-only", feedback)
        self.assertIn("Do not copy", feedback)
        self.assertNotIn("ensure that the correct answer is included", feedback)

    def test_cli_mode_uses_chat_and_reflection_callables(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fake_cli(directory)
            gepa_directory = Path(directory) / "gepa"
            default_adapter_directory = gepa_directory / "adapters" / "default_adapter"
            default_adapter_directory.mkdir(parents=True)
            (gepa_directory / "__init__.py").write_text(
                "from types import SimpleNamespace\n"
                "def optimize(*, adapter, task_lm, reflection_lm, **kwargs):\n"
                "    assert adapter is not None\n"
                "    assert callable(adapter.model)\n"
                "    assert task_lm is None\n"
                "    assert callable(reflection_lm)\n"
                "    reflective = adapter.make_reflective_dataset({}, SimpleNamespace(trajectories=[{'data': {'input': 'Hello', 'answer': 'Hello', 'additional_context': {}}, 'full_assistant_response': 'Wrong'}], scores=[0], outputs=[{}]), ['system_prompt'])\n"
                "    feedback = reflective['system_prompt'][0]['Feedback']\n"
                "    assert 'evaluation-only' in feedback\n"
                "    assert 'ensure that the correct answer is included' not in feedback\n"
                "    kwargs[\"logger\"].log(\"progress\")\n"
                "    assert reflection_lm(\"reflection\")\n"
                "    return SimpleNamespace(best_candidate={\"system_prompt\": \"candidate\"}, best_idx=0, val_aggregate_scores=[1])\n"
            )
            (gepa_directory / "adapters" / "__init__.py").write_text("")
            (default_adapter_directory / "__init__.py").write_text("")
            (default_adapter_directory / "default_adapter.py").write_text(
                "class DefaultAdapter:\n"
                "    def __init__(self, model):\n"
                "        self.model = model\n"
            )
            request = {
                "source": "Hello",
                "evaluator": {"type": "default_adapter"},
                "examples": [{"input": "Hello", "answer": "Hello"}],
                "model_config": {"task_lm": "task-model", "reflection_lm": "reflection-model"},
                "budget": {"max_metric_calls": 2},
            }
            environment = {
                "GEPA_WORKER_MODE": "cli",
                "GEPA_ALLOWED_MODELS": "task-model,reflection-model",
                "ASTRAEA_DEV_LLM_COMMAND": f'["{cli}", "success", "{{model}}"]',
                "NODE_ENV": "production",
                "ASTRAEA_ALLOW_DEV_LLM_IN_PRODUCTION": "true",
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
            self.assertEqual(json.loads(result.stdout), {"candidate": "candidate", "score": 1})


if __name__ == "__main__":
    unittest.main()
