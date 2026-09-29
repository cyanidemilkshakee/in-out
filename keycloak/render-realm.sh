#!/bin/sh
set -eu

template=${REALM_TEMPLATE_PATH:-/templates/realm-inout.json}
output=${REALM_OUTPUT_PATH:-/import/inout-realm.json}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&@]/\\&/g'
}

: "${KEYCLOAK_CLIENT_SECRET:?KEYCLOAK_CLIENT_SECRET is required}"
: "${INOUT_APP_URL:?INOUT_APP_URL is required}"

client_secret="$(escape_sed_replacement "$KEYCLOAK_CLIENT_SECRET")"
app_url="$(escape_sed_replacement "$INOUT_APP_URL")"

sed \
  -e "s@\\\${KEYCLOAK_CLIENT_SECRET}@$client_secret@g" \
  -e "s@\\\${INOUT_APP_URL}@$app_url@g" \
  "$template" > "$output"

if grep -F '${' "$output" >/dev/null; then
  echo "The Keycloak realm template contains an unresolved placeholder" >&2
  exit 1
fi
