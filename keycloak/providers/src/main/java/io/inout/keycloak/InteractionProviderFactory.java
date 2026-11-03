package io.inout.keycloak;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/** Version-pinned, server-to-server interactions for the IN/OUT app forms. */
public final class InteractionProviderFactory implements RealmResourceProviderFactory {
    public RealmResourceProvider create(KeycloakSession session) {
        return new RealmResourceProvider() {
            public Object getResource() { return new InteractionResource(session); }
            public void close() { }
        };
    }
    public String getId() { return "inout-auth"; }
    public void init(Config.Scope config) { }
    public void postInit(KeycloakSessionFactory factory) { }
    public void close() { }
}
