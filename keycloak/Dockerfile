# syntax=docker/dockerfile:1
ARG KEYCLOAK_VERSION=26.8.0
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder

# These are build options, not deployment credentials. Do the augmentation once
# so each container starts directly against the configured PostgreSQL database.
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
