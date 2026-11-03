# syntax=docker/dockerfile:1
ARG KEYCLOAK_VERSION=26.8.0
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS provider-api

# Compile against the exact runtime JARs, without fetching a second dependency
# graph. Runtime/API compatibility is deliberately pinned by the provider.
FROM eclipse-temurin:21-jdk AS provider
COPY --from=provider-api /opt/keycloak/lib/lib/main/ /keycloak-libs/
WORKDIR /provider
COPY providers/src/main/ ./src/
RUN mkdir -p classes \
    && javac --release 21 -cp '/keycloak-libs/*' -d classes $(find src/java -name '*.java') \
    && cp -R src/resources/. classes/ \
    && jar --create --file /inout-app-interactions.jar -C classes .

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder

# These are build options, not deployment credentials. Do the augmentation once
# so each container starts directly against the configured PostgreSQL database.
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true
COPY --from=provider /inout-app-interactions.jar /opt/keycloak/providers/inout-app-interactions.jar
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
