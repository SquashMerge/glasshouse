import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
HARNESS = ROOT / "infra/scripts/test-otlp-sdk-integration.sh"

FAKE_DOCKER = r'''#!/usr/bin/env python3
import json
import os
import pathlib
import re
import sys
import time

state_path = pathlib.Path(__file__).with_name("state.json")
state = json.loads(state_path.read_text())
scenario = state["scenario"]
args = sys.argv[1:]
state["calls"].append(args)
state["environments"].append({key: os.environ.get(key) for key in ("HOST_DOCKER_SECRET", "COMPOSE_FILE", "DOCKER_HOST")})

def save():
    state_path.write_text(json.dumps(state))

def project_from(values):
    return values[values.index("--project-name") + 1]

def compose_parts(values):
    start = values.index("compose")
    return values[start + 1:]

def marker_from(values):
    for value in values:
        if value.endswith("ownership.yaml"):
            match = re.search(r"io\.glasshouse\.otlp-sdk-run: ([^\n]+)", pathlib.Path(value).read_text())
            if match:
                return match.group(1)
    return ""

def resource(resource_id, kind, project, marker, name):
    return {"id": resource_id, "kind": kind, "project": project, "marker": marker, "name": name}

def matches_project(item, project):
    return item["project"] in {project, "PROJECT"}

def displayed_name(item, project):
    return item["name"].replace("PROJECT", project)

if "compose" in args:
    parts = compose_parts(args)
    project = project_from(args)
    state["project"] = project
    context = pathlib.Path(args[args.index("--project-directory") + 1])
    state["context_has_sentinel"] = (context / "arbitrary-host-secret").exists()
    if parts[-2:] == ["config", "--format"]:
        raise SystemExit("unexpected config syntax")
    if parts[-3:] == ["config", "--format", "json"]:
        if scenario == "config_error":
            save()
            raise SystemExit(17)
        network_name = "foreign_network" if scenario == "config_bad_name" else f"{project}_default"
        print(json.dumps({
            "services": {"api": {"ports": [{"published": "0"}]}, "worker": {}},
            "networks": {"default": {"name": network_name}, "private": {"name": f"{project}_private"}},
            "volumes": {"pg_data": {"name": f"{project}_pg_data"}, "ch_data": {"name": f"{project}_ch_data"}},
        }))
        save()
        raise SystemExit(0)
    if parts[-2:] == ["config", "--services"]:
        if scenario == "services_error":
            raise SystemExit(18)
        print("api\nworker")
        save()
        raise SystemExit(0)
    if parts[-2:] == ["config", "--networks"]:
        if scenario == "networks_error":
            raise SystemExit(19)
        print("default\nprivate")
        save()
        raise SystemExit(0)
    if parts[-2:] == ["config", "--volumes"]:
        if scenario == "volumes_error":
            raise SystemExit(20)
        print("pg_data\nch_data")
        save()
        raise SystemExit(0)
    if parts[-1:] == ["up"] or "up" in parts:
        marker = marker_from(args)
        state["resources"].append(resource("a" * 64, "container", project, marker, f"{project}-api-1"))
        state["resources"].append(resource("b" * 64, "network", project, marker, f"{project}_default"))
        if scenario in {"foreign_after_preflight", "partial_up_failure", "marker_mismatch"}:
            foreign_marker = "wrong-marker" if scenario == "marker_mismatch" else "foreign-marker"
            state["resources"].append(resource("c" * 64, "container", project, foreign_marker, f"{project}-foreign-1"))
        save()
        if scenario == "sigterm":
            time.sleep(30)
        raise SystemExit(23)

if args[:2] == ["ps", "-aq"]:
    if "--no-trunc" not in args:
        save()
        raise SystemExit(96)
    if scenario == "containers_inventory_error":
        save()
        raise SystemExit(24)
    project = next(value.removeprefix("label=com.docker.compose.project=") for value in args if value.startswith("label=com.docker.compose.project="))
    print("\n".join(item["id"] for item in state["resources"] if item["kind"] == "container" and matches_project(item, project)), flush=True)
    save()
    raise SystemExit(0)

if args[:3] == ["network", "ls", "-q"]:
    if "--no-trunc" not in args:
        save()
        raise SystemExit(97)
    if scenario == "networks_inventory_error":
        save()
        raise SystemExit(25)
    project = next(value.removeprefix("label=com.docker.compose.project=") for value in args if value.startswith("label=com.docker.compose.project="))
    print("\n".join(item["id"] for item in state["resources"] if item["kind"] == "network" and matches_project(item, project)), flush=True)
    save()
    raise SystemExit(0)

if args[:3] == ["volume", "ls", "-q"]:
    if scenario == "volumes_inventory_error":
        save()
        raise SystemExit(26)
    project = next(value.split("=", 1)[1] for value in args if value.startswith("label=com.docker.compose.project="))
    print("\n".join(displayed_name(item, project) for item in state["resources"] if item["kind"] == "volume" and matches_project(item, project)))
    save()
    raise SystemExit(0)

if args[:3] == ["ps", "-a", "--format"]:
    project = state.get("project", "PROJECT")
    print("\n".join(f'{item["id"]} {displayed_name(item, project)}' for item in state["resources"] if item["kind"] == "container"))
    save()
    raise SystemExit(0)
if args[:3] == ["network", "ls", "--format"]:
    project = state.get("project", "PROJECT")
    print("\n".join(f'{item["id"]} {displayed_name(item, project)}' for item in state["resources"] if item["kind"] == "network"))
    save()
    raise SystemExit(0)
if args[:3] == ["volume", "ls", "--format"]:
    project = state.get("project", "PROJECT")
    print("\n".join(displayed_name(item, project) for item in state["resources"] if item["kind"] == "volume"))
    save()
    raise SystemExit(0)

if len(args) >= 4 and args[1] == "inspect":
    kind, resource_id = args[0], args[-1]
    item = next((item for item in state["resources"] if item["id"] == resource_id and item["kind"] == kind), None)
    if not item:
        save()
        raise SystemExit(27)
    print(f'{item["id"]} {item["project"]} {item["marker"]}')
    save()
    raise SystemExit(0)

if len(args) == 3 and args[0] == "container" and args[1] in {"stop", "rm"}:
    state["resources"] = [item for item in state["resources"] if item["id"] != args[2]] if args[1] == "rm" else state["resources"]
    save()
    raise SystemExit(0)
if len(args) == 3 and args[:2] == ["network", "rm"]:
    state["resources"] = [item for item in state["resources"] if item["id"] != args[2]]
    save()
    raise SystemExit(0)

save()
raise SystemExit(99)
'''


class OtlpSdkHarnessSafetyTest(unittest.TestCase):
    def run_harness(self, scenario, *, environment=None, signal_process=False, mutate=None):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = pathlib.Path(temporary_directory)
            sandbox = temporary / "repo"
            (sandbox / "infra/scripts").mkdir(parents=True)
            (sandbox / ".github").mkdir()
            shutil.copy2(HARNESS, sandbox / "infra/scripts/test-otlp-sdk-integration.sh")
            shutil.copy2(ROOT / "infra/scripts/stage-build-context.sh", sandbox / "infra/scripts/stage-build-context.sh")
            shutil.copy2(ROOT / ".github/compose.otlp-sdk-integration.yaml", sandbox / ".github/compose.otlp-sdk-integration.yaml")
            shutil.copy2(ROOT / "infra/otlp-sdk-requirements.txt", sandbox / "infra/otlp-sdk-requirements.txt")
            shutil.copy2(ROOT / ".dockerignore", sandbox / ".dockerignore")
            for name in ("package.json", "bun.lock"):
                shutil.copy2(ROOT / name, sandbox / name)
            for app in ("api", "web"):
                (sandbox / "apps" / app).mkdir(parents=True)
                shutil.copy2(ROOT / "apps" / app / "Dockerfile", sandbox / "apps" / app / "Dockerfile")
            (sandbox / "infra" / "clickhouse").mkdir()
            shutil.copy2(ROOT / "infra/clickhouse/backup.xml", sandbox / "infra/clickhouse/backup.xml")
            (sandbox / "infra" / "db").mkdir()
            shutil.copy2(ROOT / "infra/db/migrations/0019_organizations.sql", sandbox / "infra/db/0019_organizations.sql")
            (sandbox / "worker").mkdir()
            shutil.copy2(ROOT / "worker/__init__.py", sandbox / "worker/__init__.py")
            subprocess.run(["git", "init", "--quiet"], cwd=sandbox, check=True)
            subprocess.run(["git", "add", "."], cwd=sandbox, check=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "fixture"],
                cwd=sandbox,
                check=True,
            )
            (sandbox / "arbitrary-host-secret").write_text("must-not-reach-build-context\n")
            harness = sandbox / "infra/scripts/test-otlp-sdk-integration.sh"
            if mutate:
                harness.write_text(mutate(harness.read_text()))
                subprocess.run(["git", "add", harness], cwd=sandbox, check=True)
                subprocess.run(
                    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "fixture mutation"],
                    cwd=sandbox,
                    check=True,
                )
            fake_bin = temporary / "bin"
            fake_bin.mkdir()
            docker = fake_bin / "docker"
            docker.write_text(FAKE_DOCKER)
            docker.chmod(0o755)
            state_path = fake_bin / "state.json"
            collision = json.loads(environment["FAKE_DOCKER_COLLISION"]) if environment and "FAKE_DOCKER_COLLISION" in environment else None
            state_path.write_text(json.dumps({"calls": [], "environments": [], "resources": [collision] if collision else [], "scenario": scenario}))
            env = {
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
                "HOST_DOCKER_SECRET": "must-not-reach-docker",
                "DOCKER_HOST": "tcp://hostile:2375",
            }
            if environment:
                env.update(environment)
            process = subprocess.Popen(["bash", str(harness)], cwd=sandbox, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
            if signal_process:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if any("up" in call for call in json.loads(state_path.read_text())["calls"]):
                        break
                    time.sleep(0.02)
                else:
                    self.fail("fake Docker never observed compose up before SIGTERM")
                os.killpg(process.pid, signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=10)
            return process.returncode, stdout, stderr, json.loads(state_path.read_text())

    def assert_no_mutations(self, state):
        mutating = [call for call in state["calls"] if call[:2] in (["container", "stop"], ["container", "rm"], ["network", "rm"], ["volume", "rm"])]
        self.assertEqual(mutating, [])

    def assert_docker_environment_is_scrubbed(self, state):
        self.assertTrue(state["environments"])
        self.assertTrue(all(all(value is None for value in environment.values()) for environment in state["environments"]))

    def test_rejects_project_and_compose_overrides_before_docker(self):
        for environment in ({"OTLP_SDK_PROJECT": "attacker"}, {"COMPOSE_PROJECT_NAME": "attacker"}):
            with self.subTest(environment=environment):
                code, _, stderr, state = self.run_harness("up_failure", environment=environment)
                self.assertEqual(code, 2)
                self.assertIn("must not be set", stderr)
                self.assertEqual(state["calls"], [])

    def test_rejects_generated_name_mismatch_and_config_errors_without_side_effects(self):
        for scenario in ("config_bad_name", "config_error", "services_error", "networks_error", "volumes_error"):
            with self.subTest(scenario=scenario):
                code, _, stderr, state = self.run_harness(scenario)
                self.assertNotEqual(code, 0)
                self.assertIn("refusing to start", stderr)
                self.assert_no_mutations(state)
                self.assert_docker_environment_is_scrubbed(state)

    def test_rejects_every_labeled_inventory_failure_without_side_effects(self):
        for scenario in ("containers_inventory_error", "networks_inventory_error", "volumes_inventory_error"):
            with self.subTest(scenario=scenario):
                code, _, stderr, state = self.run_harness(scenario)
                self.assertNotEqual(code, 0)
                self.assertIn("could not inventory", stderr)
                self.assert_no_mutations(state)
                self.assert_docker_environment_is_scrubbed(state)

    def test_rejects_all_labeled_and_unlabeled_predicted_name_collisions(self):
        collisions = [
            ("labeled_container", {"id": "d" * 64, "kind": "container", "project": "PROJECT", "marker": "other", "name": "unrelated"}),
            ("labeled_network", {"id": "e" * 64, "kind": "network", "project": "PROJECT", "marker": "other", "name": "unrelated"}),
            ("labeled_volume", {"id": "f" * 64, "kind": "volume", "project": "PROJECT", "marker": "other", "name": "unrelated"}),
            ("container_name", {"id": "1" * 64, "kind": "container", "project": "other", "marker": "", "name": "PROJECT-api-1"}),
            ("network_default", {"id": "2" * 64, "kind": "network", "project": "other", "marker": "", "name": "PROJECT_default"}),
            ("network_custom", {"id": "3" * 64, "kind": "network", "project": "other", "marker": "", "name": "PROJECT_private"}),
            ("volume_pg", {"id": "4" * 64, "kind": "volume", "project": "other", "marker": "", "name": "PROJECT_pg_data"}),
            ("volume_ch", {"id": "5" * 64, "kind": "volume", "project": "other", "marker": "", "name": "PROJECT_ch_data"}),
        ]
        for label, collision in collisions:
            with self.subTest(collision=label):
                code, _, stderr, state = self.run_harness("up_failure", environment={"FAKE_DOCKER_COLLISION": json.dumps(collision)})
                self.assertNotEqual(code, 0)
                self.assertIn("refusing to start", stderr)
                self.assert_no_mutations(state)
                self.assert_docker_environment_is_scrubbed(state)

    def test_partial_failure_cleans_only_exact_full_owned_ids_and_never_volumes(self):
        code, _, stderr, state = self.run_harness("partial_up_failure")
        self.assertNotEqual(code, 0)
        self.assertIn("ownership is unproven", stderr)
        self.assert_no_mutations(state)

    def test_owner_marker_mismatch_and_foreign_resource_after_preflight_are_untouched(self):
        for scenario in ("marker_mismatch", "foreign_after_preflight"):
            with self.subTest(scenario=scenario):
                code, _, stderr, state = self.run_harness(scenario)
                self.assertNotEqual(code, 0)
                self.assertIn("ownership is unproven", stderr)
                self.assert_no_mutations(state)

    def test_sigterm_cleans_only_verified_full_ids_and_never_deletes_volumes(self):
        code, _, _, state = self.run_harness("sigterm", signal_process=True)
        self.assertEqual(code, 143)
        mutations = [call for call in state["calls"] if call[:2] in (["container", "stop"], ["container", "rm"], ["network", "rm"])]
        self.assertEqual(mutations, [["container", "stop", "a" * 64], ["container", "rm", "a" * 64], ["network", "rm", "b" * 64]])
        self.assertFalse(any(call[:2] == ["volume", "rm"] for call in state["calls"]))

    def test_fixture_paths_are_root_relative_for_project_directory(self):
        fixture = (ROOT / ".github/compose.otlp-sdk-integration.yaml").read_text()
        self.assertIn("build: { context: ., dockerfile: apps/api/Dockerfile }", fixture)
        self.assertIn("./infra/clickhouse/backup.xml:", fixture)
        self.assertTrue((ROOT / "apps/api/Dockerfile").is_file())
        self.assertTrue((ROOT / "infra/clickhouse/backup.xml").is_file())

    def test_harness_stages_only_allowlisted_tracked_build_inputs(self):
        code, _, _, state = self.run_harness("up_failure")
        self.assertNotEqual(code, 0)
        compose_calls = [call for call in state["calls"] if "compose" in call]
        self.assertTrue(compose_calls)
        context = pathlib.Path(compose_calls[0][compose_calls[0].index("--project-directory") + 1])
        self.assertNotEqual(context, ROOT)
        self.assertFalse(state["context_has_sentinel"])

    def test_unsafe_short_id_mutation_fails_red_against_fake_docker(self):
        code, _, _, state = self.run_harness("up_failure", mutate=lambda source: source.replace(" --no-trunc", "", 1))
        self.assertNotEqual(code, 0)
        self.assertTrue(any(call[:2] == ["ps", "-aq"] and "--no-trunc" not in call for call in state["calls"]))
        self.assert_no_mutations(state)


if __name__ == "__main__":
    unittest.main()
