"""Development-only stdin/stdout adapter for locally authenticated LLM CLIs."""
import json
import os
import signal
import subprocess
import threading
import time

DEFAULT_TIMEOUT_SECONDS = 60
MAX_TIMEOUT_SECONDS = 1800
DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 64 * 1024


class DevCliLlmError(RuntimeError):
    pass


def _positive_integer(name, default, maximum):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        integer = int(value)
    except ValueError as error:
        raise DevCliLlmError(f"{name} must be a positive integer") from error
    if not 0 < integer <= maximum:
        raise DevCliLlmError(f"{name} must be between 1 and {maximum}")
    return integer


def command_for_model(model):
    raw_command = os.environ.get("GLASSHOUSE_DEV_LLM_COMMAND")
    if not raw_command:
        raise DevCliLlmError("GLASSHOUSE_DEV_LLM_COMMAND must configure a JSON argv array")
    try:
        command = json.loads(raw_command)
    except json.JSONDecodeError as error:
        raise DevCliLlmError("GLASSHOUSE_DEV_LLM_COMMAND must be a JSON argv array") from error
    if not isinstance(command, list) or not command or not all(isinstance(argument, str) and argument for argument in command):
        raise DevCliLlmError("GLASSHOUSE_DEV_LLM_COMMAND must be a non-empty JSON argv array of strings")
    return [argument.replace("{model}", model) for argument in command]


def run_dev_cli(prompt, model, provider_dispatch_key=None):
    if not isinstance(prompt, str) or not isinstance(model, str) or not model:
        raise DevCliLlmError("development CLI requires a prompt and model")
    timeout = _positive_integer("GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
    max_output_bytes = _positive_integer("GLASSHOUSE_DEV_LLM_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
    try:
        environment = os.environ.copy()
        if provider_dispatch_key is not None:
            environment["GLASSHOUSE_PROVIDER_DISPATCH_KEY"] = provider_dispatch_key
        process = subprocess.Popen(
            command_for_model(model),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=environment,
        )
    except OSError as error:
        raise DevCliLlmError("development CLI command is unavailable") from error

    output = bytearray()
    output_exceeded = threading.Event()

    def stop_process_group():
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def write_stdin():
        try:
            if process.stdin:
                process.stdin.write(prompt.encode("utf-8"))
                process.stdin.close()
        except OSError:
            pass

    def read_stdout():
        if not process.stdout:
            return
        while chunk := process.stdout.read(8192):
            remaining = max_output_bytes + 1 - len(output)
            output.extend(chunk[:remaining])
            if len(output) > max_output_bytes:
                output_exceeded.set()
                stop_process_group()
                break

    writer = threading.Thread(target=write_stdin)
    reader = threading.Thread(target=read_stdout)
    deadline = time.monotonic() + timeout
    writer.start()
    reader.start()
    timed_out = False
    try:
        process.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        stop_process_group()
        process.wait()
        timed_out = True
    finally:
        for thread in (writer, reader):
            thread.join(max(0, deadline - time.monotonic()))
            if thread.is_alive():
                stop_process_group()
                process.wait()
                thread.join()
                timed_out = True
        if process.stdout:
            process.stdout.close()

    if timed_out:
        raise DevCliLlmError("development CLI timed out")
    if output_exceeded.is_set():
        raise DevCliLlmError("development CLI output exceeded size limit")
    if process.returncode:
        raise DevCliLlmError("development CLI exited unsuccessfully")
    try:
        return output.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DevCliLlmError("development CLI returned invalid UTF-8") from error


def task_lm_for_model(model, next_dispatch_key=None):
    def task_lm(messages):
        if not isinstance(messages, list):
            raise DevCliLlmError("task LLM must receive chat messages")
        return run_dev_cli(
            json.dumps(messages, ensure_ascii=False),
            model,
            next_dispatch_key() if next_dispatch_key else None,
        )

    return task_lm


def reflection_lm_for_model(model, next_dispatch_key=None):
    def reflection_lm(prompt):
        return run_dev_cli(prompt, model, next_dispatch_key() if next_dispatch_key else None)

    return reflection_lm
