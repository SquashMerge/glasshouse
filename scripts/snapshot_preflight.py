#!/usr/bin/env python3
"""Read-only GHCR preflight. This command cannot publish images."""
import argparse
import json
import subprocess
import sys
from snapshot_admission import SHA, admit_exact

ORG = "SquashMerge"
PACKAGES = ("glasshouse-api-snapshot", "glasshouse-web-snapshot")

def github_get(endpoint):
    if endpoint not in tuple(f"orgs/{ORG}/packages/container/{name}" for name in PACKAGES):
        raise ValueError("unapproved GitHub endpoint")
    result = subprocess.run(["gh", "api", "--hostname", "github.com", "--method", "GET", endpoint],
                            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, timeout=30)
    return json.loads(result.stdout)

def check_package(data, name):
    if (not isinstance(data, dict) or type(data.get("id")) is not int
            or data["id"] <= 0 or data.get("name") != name
            or data.get("package_type") != "container"
            or data.get("visibility") != "private"
            or not isinstance(data.get("owner"), dict)
            or data["owner"].get("type") != "Organization"
            or not isinstance(data["owner"].get("login"), str)
            or data["owner"]["login"].lower() != ORG.lower()):
        raise ValueError("package metadata missing, mismatched, or not private: " + name)
    return {"id": data["id"], "name": name, "visibility": "private"}

def package_metadata():
    return [check_package(github_get(f"orgs/{ORG}/packages/container/{name}"), name)
            for name in PACKAGES]


def preflight(sha):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise ValueError("SHA must be a full lowercase commit SHA")
    admission = admit_exact(sha)
    if admission.get("sha") != sha or admission.get("state") != "gates-passed":
        raise ValueError("source gate admission failed")
    packages = package_metadata()
    # Package metadata does not establish inheritance or all Actions grants.
    return {"sha": sha, "state": "blocked", "publication": "disabled",
            "admission": admission["evidence"], "packages": packages,
            "blockers": ["package-access-policy-unverified",
                         "candidate-pair-not-built-tested-scanned",
                         "publisher-not-enabled"]}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", metavar="FULL_SHA", help="perform read-only live preflight")
    group.add_argument("--packages", action="store_true", help="inspect package metadata only")
    args = parser.parse_args(argv)
    if args.check is None and not args.packages:
        print(json.dumps({"state": "noop", "publication": "disabled"}))
        return 0
    try:
        if args.packages:
            report = {"state": "blocked", "publication": "disabled",
                      "packages": package_metadata(),
                      "blockers": ["source-gates-not-checked", "package-access-policy-unverified",
                                   "candidate-pair-not-built-tested-scanned", "publisher-not-enabled"]}
        else:
            report = preflight(args.check)
        print(json.dumps(report, indent=2))
        return 1
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({"state": "blocked", "publication": "disabled",
                          "error": type(exc).__name__}), file=sys.stderr)
        return 2

if __name__ == "__main__":
    sys.exit(main())
