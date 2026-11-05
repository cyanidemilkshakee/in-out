package io.inout.keycloak;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.HttpHeaders;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.MultivaluedHashMap;
import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriInfo;
import jakarta.ws.rs.ext.Provider;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.Arrays;
import org.keycloak.OAuth2Constants;
import org.keycloak.authentication.AuthenticationFlowException;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.common.Version;
import org.keycloak.common.util.Time;
import org.keycloak.events.Details;
import org.keycloak.events.Errors;
import org.keycloak.events.EventBuilder;
import org.keycloak.events.EventType;
import org.keycloak.http.FormPartValue;
import org.keycloak.http.HttpRequest;
import org.keycloak.models.AuthenticatedClientSessionModel;
import org.keycloak.models.ClientModel;
import org.keycloak.models.ClientSessionContext;
import org.keycloak.models.Constants;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.ModelException;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserCredentialModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.models.utils.AuthenticationFlowResolver;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.protocol.oidc.OIDCAdvancedConfigWrapper;
import org.keycloak.protocol.oidc.TokenManager;
import org.keycloak.protocol.oidc.utils.AuthorizeClientUtil;
import org.keycloak.services.Urls;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.managers.AuthenticationSessionManager;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.sessions.RootAuthenticationSessionModel;
import org.keycloak.util.JsonSerialization;
import org.keycloak.userprofile.EventAuditingAttributeChangeListener;
import org.keycloak.userprofile.UserProfile;
import org.keycloak.userprofile.UserProfileContext;
import org.keycloak.userprofile.UserProfileProvider;
import org.keycloak.userprofile.ValidationException;

/**
 * Custom interaction protocol, not a standard OAuth browser flow. Passwords
 * enter only verify, never a stored ticket. Authentication uses the realm's
 * configured native credential/OTP flow and required-action trigger logic.
 * Access/ID/refresh tokens are issued by Keycloak only on one-use PKCE redeem.
 */
@Provider
@Produces(MediaType.APPLICATION_JSON)
public final class InteractionResource {
    private static final System.Logger LOG = System.getLogger(InteractionResource.class.getName());
    private static final String CLIENT_ID = "inout-frontend";
    private static final String ENABLED = "inout.app-interactions.enabled";
    private static final String PREFIX = "inout:interaction:v1:";
    private static final Set<String> APP_ROLES = Set.of("operator", "zone-admin", "master-admin");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final ObjectMapper JSON = JsonSerialization.mapper.copy()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private final KeycloakSession session;
    private final RealmModel realm;
    private final HttpRequest original;

    public InteractionResource(KeycloakSession session) {
        this.session = session;
        this.realm = session.getContext().getRealm();
        this.original = session.getContext().getHttpRequest();
    }

    @GET @Path("status")
    public Response status() {
        return boundary(() -> {
            client(false);
            return reply(200, Map.of("extensionVersion", 1, "keycloakVersion", Version.VERSION,
                "protocol", "inout-app-interactions-v1"));
        });
    }

    @POST @Path("prepare") @Consumes(MediaType.APPLICATION_JSON)
    public Response prepare(InputStream input) {
        return boundary(() -> {
            client(true);
            JsonNode body = body(input, Set.of("username", "expectedSubject"));
            UserModel user = resolve(text(body, "username", 254, true));
            eligibleUser(user);
            expected(body, user, false);
            return reply(200, Map.of("subject", user.getId()));
        });
    }

    @POST @Path("verify") @Consumes(MediaType.APPLICATION_JSON)
    public Response verify(InputStream input) {
        return boundary(() -> {
            ClientModel client = client(true);
            JsonNode body = body(input, Set.of("mode", "username", "currentPassword", "otp", "newPassword", "expectedSubject", "codeChallenge", "email", "firstName", "lastName"));
            String mode = text(body, "mode", 12, true);
            if (!Set.of("login", "setup", "change", "profile").contains(mode)) throw failure(400, "invalid_request");
            String username = text(body, "username", 254, true);
            String password = text(body, "currentPassword", 128, true);
            String otp = text(body, "otp", 8, false);
            if (otp != null && !otp.isEmpty() && !otp.matches("[0-9]{6,8}")) throw failure(400, "invalid_request");
            String newPassword = text(body, "newPassword", 128, false);
            String challenge = text(body, "codeChallenge", 128, false);
            String email = null;
            String firstName = null;
            String lastName = null;
            if (mode.equals("login")) {
                if (newPassword != null || body.has("email") || body.has("firstName") || body.has("lastName") || challenge == null || !challenge.matches("[A-Za-z0-9_-]{43}")) throw failure(400, "invalid_request");
            } else if (mode.equals("profile")) {
                if (newPassword != null || challenge != null) throw failure(400, "invalid_request");
                email = text(body, "email", 254, true).trim();
                firstName = text(body, "firstName", 256, true).trim();
                lastName = text(body, "lastName", 256, true).trim();
                if (email.isEmpty() || firstName.isEmpty() || lastName.isEmpty()) throw failure(400, "invalid_request");
            } else if (newPassword == null || newPassword.isBlank() || newPassword.equals(password)) {
                throw failure(400, "invalid_request");
            }
            if (!mode.equals("profile") && (body.has("email") || body.has("firstName") || body.has("lastName"))) throw failure(400, "invalid_request");
            if (!mode.equals("login") && text(body, "expectedSubject", 256, true) == null) throw failure(400, "invalid_request");
            EventBuilder event = event(EventType.LOGIN).client(client).detail(Details.AUTH_METHOD, "inout_app_interaction");
            RootAuthenticationSessionModel root = session.authenticationSessions().createRootAuthenticationSession(realm);
            AuthenticationSessionModel auth = root.createAuthenticationSession(client);
            boolean retain = false;
            try {
                initialize(auth);
                MultivaluedMap<String, String> form = new MultivaluedHashMap<>();
                form.putSingle("username", username);
                form.putSingle("password", password);
                if (otp != null && !otp.isEmpty()) form.putSingle("totp", otp);
                HttpRequest wrapped = new FormRequest(original, form);
                AuthenticationProcessor processor = processor(auth, wrapped, event);
                Response challengeResponse;
                try { challengeResponse = processor.authenticateOnly(); }
                catch (AuthenticationFlowException exception) { throw failure(401, "credentials"); }
                if (challengeResponse != null) {
                    int status = challengeResponse.getStatus();
                    challengeResponse.close();
                    throw failure(status >= 500 ? 503 : 401, status >= 500 ? "service_unavailable" : "credentials");
                }
                UserModel user = auth.getAuthenticatedUser();
                eligibleUser(user);
                expected(body, user, !mode.equals("login"));
                // Do not trust a custom realm flow that omits the password
                // verifier or conditionally skips an enrolled OTP credential.
                if (!"true".equals(auth.getAuthNote(AuthenticationManager.PASSWORD_VALIDATED))) throw failure(503, "service_unavailable");
                if (user.credentialManager().isConfiguredFor("otp") && !org.keycloak.authentication.AuthenticatorUtil.getAuthnCredentials(auth).contains("otp")) {
                    throw failure(503, "service_unavailable");
                }
                processor.evaluateRequiredActionTriggers();
                Set<String> actions = actions(auth, user);
                if (mode.equals("login")) {
                    if (actions.equals(Set.of("VERIFY_PROFILE")) || actions.equals(Set.of("UPDATE_PROFILE"))) throw failure(409, "profile_setup_required");
                    if (!actions.isEmpty()) throw failure(409, actions.equals(Set.of("UPDATE_PASSWORD")) ? "account_setup_required" : "not_ready");
                    int now = Time.currentTime();
                    auth.setUserSessionNote(AuthenticationManager.AUTH_TIME, String.valueOf(now));
                    AuthenticationManager.logSuccess(session, auth);
                    String code = random();
                    Map<String, String> ticket = new HashMap<>();
                    ticket.put("client", client.getId());
                    ticket.put("realm", realm.getId());
                    ticket.put("root", root.getId());
                    ticket.put("tab", auth.getTabId());
                    ticket.put("subject", user.getId());
                    ticket.put("challenge", challenge);
                    ticket.put("expires", String.valueOf(now + 30));
                    ticket.put("authTime", String.valueOf(now));
                    ticket.put("fingerprint", fingerprint(user));
                    session.singleUseObjects().put(PREFIX + hash(code), 30, ticket);
                    retain = true;
                    return reply(200, Map.of("code", code, "expiresIn", 30, "subject", user.getId()));
                }
                if (mode.equals("profile")) {
                    if (!(actions.equals(Set.of("VERIFY_PROFILE")) || actions.equals(Set.of("UPDATE_PROFILE")))) throw failure(409, "state_changed");
                    Map<String, List<String>> attributes = new HashMap<>();
                    attributes.put(UserModel.EMAIL, List.of(email));
                    attributes.put(UserModel.FIRST_NAME, List.of(firstName));
                    attributes.put(UserModel.LAST_NAME, List.of(lastName));
                    EventBuilder profileEvent = event(EventType.UPDATE_PROFILE).client(client).user(user)
                        .detail(Details.CONTEXT, UserProfileContext.ACCOUNT.name());
                    try {
                        UserProfile profile = session.getProvider(UserProfileProvider.class)
                            .create(UserProfileContext.ACCOUNT, attributes, user);
                        profile.update(new EventAuditingAttributeChangeListener(profile, profileEvent));
                    } catch (ValidationException exception) {
                        session.getTransactionManager().setRollbackOnly();
                        throw failure(422, "profile_invalid");
                    } catch (org.keycloak.storage.ReadOnlyException exception) {
                        session.getTransactionManager().setRollbackOnly();
                        throw failure(409, "state_changed");
                    }
                    user.removeRequiredAction("VERIFY_PROFILE");
                    user.removeRequiredAction("UPDATE_PROFILE");
                    auth.removeRequiredAction("VERIFY_PROFILE");
                    auth.removeRequiredAction("UPDATE_PROFILE");
                    profileEvent.success();
                    return reply(200, Map.of("ok", true, "subject", user.getId()));
                }
                if ((mode.equals("setup") && !actions.equals(Set.of("UPDATE_PASSWORD"))) ||
                    (mode.equals("change") && !actions.isEmpty())) throw failure(401, "credentials");
                EventBuilder credentialEvent = event(EventType.UPDATE_CREDENTIAL).client(client).user(user)
                    .detail(Details.CREDENTIAL_TYPE, "password");
                try {
                    if (!user.credentialManager().updateCredential(UserCredentialModel.password(newPassword, false))) {
                        credentialEvent.clone().error(Errors.PASSWORD_REJECTED);
                        credentialEvent.clone().event(EventType.UPDATE_PASSWORD).error(Errors.PASSWORD_REJECTED);
                        session.getTransactionManager().setRollbackOnly();
                        throw failure(422, "password_policy");
                    }
                } catch (ModelException exception) {
                    credentialEvent.clone().error(Errors.PASSWORD_REJECTED);
                    credentialEvent.clone().event(EventType.UPDATE_PASSWORD).error(Errors.PASSWORD_REJECTED);
                    session.getTransactionManager().setRollbackOnly();
                    throw failure(422, "password_policy");
                }
                user.removeRequiredAction(UserModel.RequiredAction.UPDATE_PASSWORD);
                auth.removeRequiredAction(UserModel.RequiredAction.UPDATE_PASSWORD);
                AuthenticationManager.logSuccess(session, auth);
                credentialEvent.success();
                credentialEvent.clone().event(EventType.UPDATE_PASSWORD).success();
                return reply(200, Map.of("ok", true, "subject", user.getId()));
            } finally {
                if (!retain) session.authenticationSessions().removeRootAuthenticationSession(realm, root);
            }
        });
    }

    @POST @Path("token") @Consumes(MediaType.APPLICATION_JSON)
    public Response token(InputStream input) {
        return boundary(() -> {
            ClientModel client = client(true);
            JsonNode body = body(input, Set.of("code", "codeVerifier"));
            String code = text(body, "code", 256, true);
            String verifier = text(body, "codeVerifier", 128, true);
            if (!code.matches("[A-Za-z0-9_-]{43}") || !verifier.matches("[A-Za-z0-9._~-]{43,128}")) throw failure(401, "credentials");
            Map<String, String> ticket = session.singleUseObjects().remove(PREFIX + hash(code));
            if (ticket == null) throw failure(401, "credentials");
            RootAuthenticationSessionModel root = session.authenticationSessions().getRootAuthenticationSession(realm, ticket.get("root"));
            try {
                if (!client.getId().equals(ticket.get("client")) || !realm.getId().equals(ticket.get("realm")) ||
                    Integer.parseInt(ticket.get("expires")) <= Time.currentTime() ||
                    !constantTime(hash(verifier), ticket.get("challenge")) || root == null) throw failure(401, "credentials");
                AuthenticationSessionModel auth = root.getAuthenticationSession(client, ticket.get("tab"));
                if (auth == null || auth.getAuthenticatedUser() == null) throw failure(401, "credentials");
                // This is a new request after credential verification. Native
                // mappers and required actions resolve their current session
                // through the Keycloak context as well as the explicit arg.
                session.getContext().setAuthenticationSession(auth);
                UserModel user = session.users().getUserById(realm, ticket.get("subject"));
                eligibleUser(user);
                if (!user.getId().equals(auth.getAuthenticatedUser().getId()) || !constantTime(fingerprint(user), ticket.get("fingerprint"))) throw failure(409, "state_changed");
                EventBuilder event = event(EventType.LOGIN).client(client).user(user).detail(Details.AUTH_METHOD, "inout_app_interaction");
                AuthenticationManager.evaluateRequiredActionTriggers(session, auth, original, event, realm, user);
                if (!actions(auth, user).isEmpty()) throw failure(409, "state_changed");
                AuthenticationManager.setClientScopesInSession(session, auth);
                ClientSessionContext context = AuthenticationProcessor.attachSession(auth, null, session, realm, session.getContext().getConnection(), event);
                // This REST interaction is not a registered OAuth grant.
                // Leave GRANT_TYPE unset: Keycloak's token-context encoder
                // uses its supported "na" value, including during refresh.
                // An invented grant URN cannot be encoded into a native jti.
                UserSessionModel userSession = context.getClientSession().getUserSession();
                TokenManager.AccessTokenResponseBuilder tokens = new TokenManager().responseBuilder(realm, client, event, session, userSession, context)
                    .generateAccessToken().generateRefreshToken().generateIDToken().generateAccessTokenHash();
                // Direct credential flows may omit the optional auth_time
                // mapper. This protocol explicitly attests verification time;
                // never let the app substitute token issuance time for it.
                tokens.getIdToken().setAuth_time(Long.parseLong(ticket.get("authTime")));
                Object response = tokens.build();
                event.success();
                return reply(200, response);
            } finally {
                if (root != null) session.authenticationSessions().removeRootAuthenticationSession(realm, root);
            }
        });
    }

    private ClientModel client(boolean enabledRequired) {
        if (!Version.VERSION.equals("26.8.1")) throw failure(503, "service_unavailable");
        if (!"https".equals(session.getContext().getUri().getBaseUri().getScheme()) &&
            realm.getSslRequired().isRequired(session.getContext().getConnection())) throw failure(403, "not_ready");
        List<String> authorization = original.getHttpHeaders().getRequestHeaders().get(HttpHeaders.AUTHORIZATION);
        if (authorization == null || authorization.size() != 1 || !authorization.get(0).startsWith("Basic ") || authorization.get(0).length() > 2048 ||
            original.getHttpHeaders().getHeaderString("Origin") != null) throw failure(401, "credentials");
        ClientModel client;
        try { client = AuthorizeClientUtil.authorizeClient(session, event(EventType.CLIENT_LOGIN), null).getClient(); }
        catch (WebApplicationException exception) { throw failure(401, "credentials"); }
        if (!realm.isEnabled() || client == null || !CLIENT_ID.equals(client.getClientId()) || client.isPublicClient() || client.isBearerOnly() || !client.isEnabled() || client.isConsentRequired() ||
            !OIDCLoginProtocol.LOGIN_PROTOCOL.equals(client.getProtocol()) ||
            (enabledRequired && !"true".equals(client.getAttribute(ENABLED)))) throw failure(403, "not_ready");
        OIDCAdvancedConfigWrapper advanced = OIDCAdvancedConfigWrapper.fromClientModel(client);
        // This custom bearer-token protocol cannot satisfy proof-of-possession
        // or browser ACR policies. Refuse those clients rather than downgrade.
        if (advanced.isUseDPoP() || advanced.isUseMtlsHokToken() || !advanced.isUseRefreshToken() ||
            (advanced.getMinimumAcrValue() != null && !advanced.getMinimumAcrValue().isBlank())) throw failure(403, "not_ready");
        if (enabledRequired) {
            // Standard OAuth client-policy contexts are not emitted by this
            // bespoke interaction protocol. Refuse all enabled realm/global
            // policies until their semantics are explicitly supported here.
            try {
                var policies = session.clientPolicy().getClientPolicies(realm, true);
                if ((policies.getPolicies() != null && policies.getPolicies().stream().anyMatch(policy -> policy == null || Boolean.TRUE.equals(policy.isEnabled()))) ||
                    (policies.getGlobalPolicies() != null && policies.getGlobalPolicies().stream().anyMatch(policy -> policy == null || Boolean.TRUE.equals(policy.isEnabled())))) {
                    throw failure(403, "not_ready");
                }
            } catch (Failure failure) { throw failure; }
            catch (Exception exception) { throw failure(503, "service_unavailable"); }
        }
        return client;
    }

    private void initialize(AuthenticationSessionModel auth) {
        auth.setProtocol(OIDCLoginProtocol.LOGIN_PROTOCOL);
        auth.setAction(AuthenticatedClientSessionModel.Action.AUTHENTICATE.name());
        auth.setClientNote(OIDCLoginProtocol.ISSUER, Urls.realmIssuer(session.getContext().getUri().getBaseUri(), realm.getName()));
        auth.setClientNote(OIDCLoginProtocol.SCOPE_PARAM, "openid profile email");
        session.getContext().setAuthenticationSession(auth);
    }

    private AuthenticationProcessor processor(AuthenticationSessionModel auth, HttpRequest request, EventBuilder event) {
        return new AuthenticationProcessor().setAuthenticationSession(auth)
            .setFlowId(AuthenticationFlowResolver.resolveDirectGrantFlow(auth).getId()).setFlowPath("inout-auth")
            .setConnection(session.getContext().getConnection()).setEventBuilder(event).setRealm(realm).setSession(session)
            .setUriInfo(session.getContext().getUri()).setRequest(request);
    }

    private EventBuilder event(EventType type) { return new EventBuilder(realm, session, session.getContext().getConnection()).event(type); }
    private static Set<String> actions(AuthenticationSessionModel auth, UserModel user) {
        Set<String> actions = new HashSet<>(auth.getRequiredActions());
        user.getRequiredActionsStream().forEach(actions::add);
        return actions;
    }
    private UserModel resolve(String username) {
        try { return KeycloakModelUtils.findUserByNameOrEmail(session, realm, username.trim()); }
        catch (ModelException exception) { throw failure(401, "credentials"); }
    }
    private void eligibleUser(UserModel user) {
        if (user == null || !user.isEnabled() || user.getServiceAccountClientLink() != null || APP_ROLES.stream().noneMatch(name -> {
            var role = realm.getRole(name); return role != null && user.hasRole(role);
        })) throw failure(401, "credentials");
    }
    private static void expected(JsonNode body, UserModel user, boolean required) {
        String expected = text(body, "expectedSubject", 256, required);
        if (expected != null && !constantTime(expected, user.getId())) throw failure(401, "credentials");
    }
    private static String fingerprint(UserModel user) {
        List<String> credentials = new ArrayList<>();
        user.credentialManager().getStoredCredentialsStream().forEach(credential -> credentials.add(
            credential.getId() + "\n" + credential.getType() + "\n" + credential.getCreatedDate() + "\n" +
            credential.getCredentialData() + "\n" + credential.getSecretData()));
        credentials.sort(String::compareTo);
        return hash(user.getId() + "\n" + user.getUsername() + "\n" + user.isEnabled() + "\n" +
            new TreeSet<>(user.getRequiredActionsStream().toList()) + "\n" +
            new TreeSet<>(user.getRealmRoleMappingsStream().map(role -> role.getId()).toList()) + "\n" + String.join("\n", credentials));
    }
    private static JsonNode body(InputStream input, Set<String> fields) {
        try {
            byte[] bytes = input.readNBytes(8193);
            if (bytes.length > 8192) throw failure(413, "invalid_request");
            JsonNode body = JSON.readTree(bytes);
            if (body == null || !body.isObject()) throw failure(400, "invalid_request");
            var iterator = body.fieldNames();
            while (iterator.hasNext()) if (!fields.contains(iterator.next())) throw failure(400, "invalid_request");
            return body;
        } catch (Failure failure) { throw failure; }
        catch (Exception exception) { throw failure(400, "invalid_request"); }
    }
    private static String text(JsonNode body, String field, int max, boolean required) {
        JsonNode node = body.get(field);
        if (node == null) { if (required) throw failure(400, "invalid_request"); return null; }
        if (!node.isTextual()) throw failure(400, "invalid_request");
        String value = node.textValue();
        if (value.length() > max || (required && (field.equals("currentPassword") ? value.isEmpty() : value.isBlank())) ||
            (!field.toLowerCase().contains("password") && value.chars().anyMatch(c -> c < 32 || c == 127))) throw failure(400, "invalid_request");
        return value;
    }
    private static String random() { byte[] bytes = new byte[32]; RANDOM.nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static String hash(String value) {
        try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception exception) { throw new IllegalStateException(); }
    }
    private static boolean constantTime(String left, String right) {
        return left != null && right != null && MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
    }
    private static Failure failure(int status, String code) { return new Failure(status, code); }
    private static Response reply(int status, Object body) { return Response.status(status).type(MediaType.APPLICATION_JSON_TYPE)
        .header("Cache-Control", "no-store, max-age=0").header("Pragma", "no-cache").entity(body).build(); }
    private Response boundary(Operation operation) {
        try { return operation.run(); }
        catch (Failure failure) { return reply(failure.status, Map.of("error", failure.code)); }
        catch (Exception exception) {
            // Exception messages/causes can contain provider responses. Log
            // only the type and source locations, never payloads or secrets.
            LOG.log(System.Logger.Level.ERROR, "INOUT interaction failed: type={0} locations={1}", exception.getClass().getName(),
                Arrays.stream(exception.getStackTrace()).limit(10).map(StackTraceElement::toString).toList());
            session.getTransactionManager().setRollbackOnly();
            return reply(503, Map.of("error", "service_unavailable"));
        }
    }
    private interface Operation { Response run(); }
    private static final class Failure extends RuntimeException {
        final int status; final String code;
        Failure(int status, String code) { super(code); this.status = status; this.code = code; }
    }
    private record FormRequest(HttpRequest delegate, MultivaluedMap<String, String> form) implements HttpRequest {
        public String getHttpMethod() { return delegate.getHttpMethod(); }
        public MultivaluedMap<String, String> getDecodedFormParameters() { return form; }
        public MultivaluedMap<String, FormPartValue> getMultiPartFormParameters() { return delegate.getMultiPartFormParameters(); }
        public HttpHeaders getHttpHeaders() { return delegate.getHttpHeaders(); }
        public X509Certificate[] getClientCertificateChain() { return delegate.getClientCertificateChain(); }
        public UriInfo getUri() { return delegate.getUri(); }
        public boolean isProxyTrusted() { return delegate.isProxyTrusted(); }
    }
}
