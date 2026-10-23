"""Start live disposable targets and prove both allowed and denied connectivity.

Run from the host with Docker Compose available. The fixture uses only synthetic
credentials, private networks and tmpfs databases; no host ports are published.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess


TARGETS = {
    "postgres-primary": (5432, {"app-db", "identity-db", "temporal-db"}),
    "redis": (6379, {"cache"}),
    "temporal": (7233, {"workflow", "temporal-db"}),
}
ROOT = Path(__file__).resolve().parents[2]


def docker(*args, capture=False, environment=None):
    result = subprocess.run(["docker", *args], cwd=ROOT, env=environment,
                            text=True, check=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def inventory(project, compose):
    endpoints = []
    for service, (port, expected_networks) in TARGETS.items():
        container_ids = docker(*compose, "ps", "--quiet", service, capture=True).splitlines()
        if len(container_ids) != 1:
            raise RuntimeError(f"Expected exactly one live fixture container for {service}")
        container = json.loads(docker("inspect", container_ids[0], capture=True))[0]
        labels = container["Config"]["Labels"]
        if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != service:
            raise RuntimeError("Refusing a target outside the selected test project")
        if not container["State"]["Running"] or container["HostConfig"]["PortBindings"]:
            raise RuntimeError("Fixture targets must be running without published ports")
        networks = container["NetworkSettings"]["Networks"]
        actual_networks = set()
        for name, interface in networks.items():
            network = json.loads(docker("network", "inspect", name, capture=True))[0]
            network_labels = network["Labels"]
            logical_name = network_labels.get("com.docker.compose.network")
            if network_labels.get("com.docker.compose.project") != project or not network["Internal"]:
                raise RuntimeError("Refusing a network outside the private test fixture")
            if logical_name not in expected_networks:
                raise RuntimeError(f"Unexpected target network for {service}")
            address = ipaddress.ip_address(interface["IPAddress"])
            if address.version != 4 or not address.is_private or address.is_loopback:
                raise RuntimeError("Expected an assigned private Docker IPv4")
            actual_networks.add(logical_name)
            endpoints.append({"service": service, "network": logical_name, "address": str(address), "port": port})
        if actual_networks != expected_networks:
            raise RuntimeError(f"Fixture target {service} lacks a required network")
    return endpoints


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    # Authorization regressions deliberately rotate the other fixture's
    # credentials. Keep connectivity witnesses in a fresh independent project.
    parser.add_argument("--project", default="inout-network-boundary-test")
    args = parser.parse_args()
    if not re.fullmatch(r"inout-[a-z0-9-]+-test", args.project):
        parser.error("The disposable project must have an inout- prefix and -test suffix")
    compose = ("compose", "-p", args.project, "-f", "infrastructure/compose.test.yaml",
               "-f", "infrastructure/temporal/compose.fixture.yaml")
    docker(*compose, "up", "--build", "-d", "postgres-primary", "redis", "temporal")
    endpoints = inventory(args.project, compose)
    environment = os.environ.copy()
    environment["FIXTURE_ENDPOINTS"] = json.dumps(endpoints, separators=(",", ":"))
    for service in ("network-control", "edge-probe", "network-control"):
        docker(*compose, "run", "--no-deps", "--rm", "-e", "FIXTURE_ENDPOINTS", service, environment=environment)
    if inventory(args.project, compose) != endpoints:
        raise RuntimeError("Target inventory changed during the probes")
    print("Network isolation passed with live positive controls before and after the web probe")


if __name__ == "__main__":
    main()
