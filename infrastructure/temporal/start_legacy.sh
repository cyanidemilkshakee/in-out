#!/bin/bash
set -eu -o pipefail

# The verified existing cluster has four shards. Never change its partitioning.
if [[ "${NUM_HISTORY_SHARDS:-}" != 4 ]]; then
    echo 'Legacy Temporal recovery requires the verified four-shard configuration' >&2
    exit 1
fi
if [[ "${DB:-}" != postgres12 || "${POSTGRES_USER:-}" != inout_temporal ||
      "${DBNAME:-}" != temporal || "${VISIBILITY_DBNAME:-}" != temporal_visibility ]]; then
    echo 'Legacy Temporal recovery requires the scoped PostgreSQL configuration' >&2
    exit 1
fi

# Match the official entrypoint's membership address handling. The image is
# nonroot, read-only, and uses /tmp tmpfs; rendered credentials remain mode 0600.
umask 077
export BIND_ON_IP=0.0.0.0
if [[ -z "${TEMPORAL_BROADCAST_ADDRESS:-}" ]]; then
    TEMPORAL_BROADCAST_ADDRESS="$(getent hosts "$(hostname)" | awk 'NR == 1 {print $1}')"
    export TEMPORAL_BROADCAST_ADDRESS
fi
if [[ -z "${TEMPORAL_BROADCAST_ADDRESS}" ]]; then
    echo 'Legacy Temporal recovery could not resolve its private membership address' >&2
    exit 1
fi
mkdir -p /tmp/inout-temporal/config
dockerize -template /etc/temporal/config/config_template.yaml:/tmp/inout-temporal/config/docker.yaml
chmod 0600 /tmp/inout-temporal/config/docker.yaml
exec temporal-server --root /tmp/inout-temporal --config config --env docker start

