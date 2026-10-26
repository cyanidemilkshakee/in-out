FROM postgres:17-alpine

# PostgreSQL already owns its data directory. Start as that user directly,
# avoiding a root privilege-drop helper and its unrelated embedded Go runtime.
RUN apk upgrade --no-cache \
    && rm /usr/local/bin/gosu
USER postgres
