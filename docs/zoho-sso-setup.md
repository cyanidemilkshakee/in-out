# Zoho SSO with Keycloak

InOut uses Keycloak as its OIDC provider. Keycloak brokers the user's sign-in to Zoho, then returns the Keycloak session to InOut. The app starts this flow with the identity-provider alias `zoho`; keep that exact alias unless you also update the app's `kc_idp_hint` configuration.

## 1. Register the Keycloak callback in Zoho

Create a server-based OIDC application in the Zoho API Console. Register the Keycloak broker callback as its authorized redirect URI:

```text
Local:      http://auth.localhost:1005/realms/inout/broker/zoho/endpoint
Production: https://<KEYCLOAK_PUBLIC_HOSTNAME>/realms/inout/broker/zoho/endpoint
```

Use the HTTPS Keycloak hostname configured for the deployment in production. This callback is on Keycloak, not the InOut app host. Zoho requires the redirect URI used in the authorization request to match the URI registered for the client. See [Zoho's OIDC sign-in guide](https://www.zoho.com/developer/oauth/sign-in-using-zoho-oidc.html).

Keep the Zoho client ID and client secret available for the Keycloak provider setup. Do not put either value in source control or send it in chat.

## 2. Add the Zoho OIDC provider in the `inout` realm

In the Keycloak Admin Console, select the `inout` realm, then add an **OpenID Connect v1.0** identity provider. Enter the values below in the matching fields and use alias `zoho`. The Admin Console has no paste-JSON box. To import through the UI, save this object as an item in a realm JSON file's `identityProviders` array, then open **Realm settings → Action menu → Partial import**, upload the file, select the identity provider, and import it. The standalone object below can instead be sent as the body of `POST /admin/realms/inout/identity-provider/instances`.

The endpoint values below match Zoho's US `.com` discovery document. If your Zoho account is in another data center, use that data center's `/.well-known/openid-configuration` and copy its issuer and endpoint values instead. Zoho's discovery metadata lists the endpoint URLs, signing keys, supported scopes, and claims. [Zoho discovery document](https://accounts.zoho.com/.well-known/openid-configuration)

```json
{
  "alias": "zoho",
  "displayName": "Zoho",
  "providerId": "oidc",
  "enabled": true,
  "trustEmail": true,
  "storeToken": false,
  "hideOnLogin": true,
  "config": {
    "clientId": "YOUR_ZOHO_CLIENT_ID",
    "clientSecret": "YOUR_ZOHO_CLIENT_SECRET",
    "clientAuthMethod": "client_secret_basic",
    "issuer": "https://accounts.zoho.com",
    "authorizationUrl": "https://accounts.zoho.com/oauth/v2/auth",
    "tokenUrl": "https://accounts.zoho.com/oauth/v2/token",
    "userInfoUrl": "https://accounts.zoho.com/oauth/v2/userinfo",
    "jwksUrl": "https://accounts.zoho.com/oauth/v2/keys",
    "useJwksUrl": "true",
    "validateSignature": "true",
    "defaultScope": "openid email profile",
    "userIDClaim": "sub",
    "userNameClaim": "email",
    "syncMode": "IMPORT",
    "emailClaim": "email",
    "fullNameClaim": "name",
    "givenNameClaim": "first_name",
    "familyNameClaim": "last_name",
    "pkceEnabled": "true",
    "pkceMethod": "S256"
  }
}
```

`openid` supplies the stable subject (`sub`), `email` supplies the address and its verification claim, and `profile` supplies profile claims. Do not add the `phone` scope unless InOut needs users' phone numbers. Zoho documents these scopes in its [OIDC guide](https://www.zoho.com/developer/oauth/sign-in-using-zoho-oidc.html).

Only set `trustEmail` to `true` after a test Zoho ID token confirms `email_verified: true`. InOut's invitation flow depends on a verified email to link Zoho to the pre-created Keycloak account. If Zoho does not return a verified email claim, stop and resolve that with the Zoho tenant configuration before enabling invitation-based sign-in.

The alias must remain `zoho` because the app sends `kc_idp_hint=zoho`. The generic OIDC provider ID is `oidc`; it is different from the alias. Keycloak's OIDC provider uses the `authorizationUrl`, `tokenUrl`, `userInfoUrl`, JWKS, signature validation, and client-auth settings shown above. See the [Keycloak OIDC identity-provider guide](https://www.keycloak.org/docs/26.8.1/server_admin/#_identity_broker_oidc) and [Keycloak 26.8.2 provider configuration](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/broker/oidc/OAuth2IdentityProviderConfig.java).

## 3. Apply InOut's invitation-only broker flow

After creating the `zoho` provider and confirming verified email, run the invitation setup check and apply from the repository:

```text
npm run keycloak:invitations:check
npm run keycloak:invitations:apply
npm run keycloak:invitations:check
```

The apply command creates and verifies InOut's `inout-zoho-invitation-gate` first-broker flow, configures **Detect Existing Broker User** and **Automatically Set Existing User** as required executions, and binds that flow to the Zoho provider. It also provisions or verifies the separate `inout-invitations` service client. The flow has no create-user fallback: an uninvited Zoho identity must not create a Keycloak account or gain an InOut role. Do not point this provider at Keycloak's unrestricted default first-broker flow.

The script requires the Zoho provider's **Trust Email** setting to be enabled. It does not create the Zoho OIDC provider or supply its client credentials; configure those in the previous step. For the complete invitation lifecycle and user-attribute setup, see [Zoho invitation-gated access](zoho-invitation-setup.md).

## 4. Verify the flow

1. Confirm the Zoho provider is enabled in the `inout` realm, its alias is `zoho`, signature validation uses Zoho's JWKS URL, and the invitation flow check passes.
2. Confirm the Zoho client has the exact Keycloak broker callback registered for the environment.
3. Use an existing invited account with a verified matching email. Select **Continue with Zoho** on `/login`; Zoho should return to Keycloak, then Keycloak should return to the app callback and establish the app session.
4. Try an uninvited Zoho identity. Keycloak must reject it without creating a user. Accept an invitation first, then confirm that the same invited identity can sign in.
5. If the app displays `identity_provider_failure`, check the Keycloak event log and the Zoho client redirect URI, data-center endpoints, client credentials, and verified-email claim. The app intentionally presents a generic message for upstream broker failures.

For an existing realm, add or update the provider in the Admin Console or through the Admin REST API. Keycloak's startup realm import skips a realm that already exists, so adding this object only to a startup import file will not update an existing installation. See [Keycloak realm import behavior](https://www.keycloak.org/server/importExport).
