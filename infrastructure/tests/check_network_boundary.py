"""Connectivity checks against an inventory of this disposable Docker fixture."""
import argparse
import ipaddress
import json
import os
import socket
import time


TARGETS = {
    "postgres-primary": (5432, {"app-db", "identity-db", "temporal-db"}),
    "redis": (6379, {"cache"}),
    "temporal": (7233, {"workflow", "temporal-db"}),
}


def fixture_endpoints():
    endpoints = json.loads(os.environ.get("FIXTURE_ENDPOINTS", "[]"))
    required = {(service, network) for service, (_, networks) in TARGETS.items() for network in networks}
    found = set()
    for endpoint in endpoints:
        service = endpoint["service"]
        network = endpoint["network"]
        assert service in TARGETS and network in TARGETS[service][1], "Unexpected fixture target"
        assert endpoint["port"] == TARGETS[service][0], "Unexpected fixture port"
        address = ipaddress.ip_address(endpoint["address"])
        assert address.version == 4 and address.is_private and not address.is_loopback, "Expected private fixture IPv4"
        assert (service, network) not in found, "Duplicate fixture interface"
        found.add((service, network))
    assert found == required, "Inventory must contain every live fixture interface"
    return endpoints


def check_control(endpoints):
    # Witnesses run both before and after the denied probes. A stopped service
    # or nonexistent address therefore cannot turn a broken fixture into a pass.
    deadline = time.monotonic() + 90
    for endpoint in endpoints:
        while True:
            try:
                with socket.create_connection((endpoint["address"], endpoint["port"]), timeout=2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AssertionError(f"Control cannot reach {endpoint['service']} on {endpoint['network']}") from None
                time.sleep(1)
    for service in TARGETS:
        socket.getaddrinfo(service, TARGETS[service][0], family=socket.AF_INET)
    print(f"Positive control reached all {len(endpoints)} database, Redis and Temporal interfaces")


def check_web(endpoints):
    for service in TARGETS:
        try:
            socket.getaddrinfo(service, None)
        except socket.gaierror:
            continue
        raise AssertionError(f"Web-only fixture resolved isolated service {service}")
    for endpoint in endpoints:
        try:
            connection = socket.create_connection((endpoint["address"], endpoint["port"]), timeout=1)
        except OSError:
            continue
        connection.close()
        raise AssertionError(f"Web-only fixture reached {endpoint['service']} on {endpoint['network']}")
    print(f"Web-only fixture cannot resolve or connect to any of the {len(endpoints)} live protected interfaces")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-reachable", action="store_true")
    args = parser.parse_args()
    endpoints = fixture_endpoints()
    (check_control if args.expect_reachable else check_web)(endpoints)
