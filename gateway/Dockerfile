ARG KONG_VERSION=3.9.3
FROM kong:${KONG_VERSION}

# Keep Kong's routing version while applying published distribution TLS fixes.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libssl3t64 openssl \
    && rm -rf /var/lib/apt/lists/*
USER kong
