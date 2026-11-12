#!/bin/sh
set -eu

# Compose supplies empty values after the one-time bootstrap credentials are
# retired. Remove them so Keycloak sees the options as unset on later starts.
if [ -z "${KC_BOOTSTRAP_ADMIN_USERNAME:-}" ]; then
  unset KC_BOOTSTRAP_ADMIN_USERNAME
fi
if [ -z "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  unset KC_BOOTSTRAP_ADMIN_PASSWORD
fi

exec /opt/keycloak/bin/kc.sh "$@"
