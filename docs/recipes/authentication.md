# Authenticating requests

Keep the login flow you already have. Skein only needs the server-side step that turns an incoming
request into a stable principal. Its `auth.path` uses LangGraph's `Auth` class, so the adapter is one
function:

```text
cookie or bearer token → your provider's server SDK → { identity, permissions }
```

The examples below were checked against the providers' official server documentation on 2026-09-17
(Better Auth 1.7, Auth.js `next-auth` 5.0 beta 32, `@clerk/backend` 3.16,
`@supabase/supabase-js` 2.116, `firebase-admin` 14.3, and `jose` 6.2). Provider APIs move
independently of Skein, so follow the linked provider documentation if your installed major differs.

| If your app already uses…                       | Start here                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Better Auth sessions                            | [Better Auth](#better-auth) — pass Skein's request headers through |
| Auth.js / NextAuth sessions                     | [Auth.js](#authjs--nextauth) — wrap your session reader            |
| Clerk users and organizations                   | [Clerk](#clerk) — authenticate the whole request                   |
| Supabase Auth                                   | [Supabase](#supabase-auth) — verify its access token               |
| Firebase Auth                                   | [Firebase](#firebase-auth) — verify its ID token                   |
| Auth0, Okta, Cognito, WorkOS, or another issuer | [OIDC/JWT](#auth0-okta-cognito-workos-or-another-oidc-issuer)      |

Nothing here replaces your sign-in page, callbacks, or session storage. Those stay with the provider
you already chose; this page is only the bridge at the API boundary.

## Wire the provider into Skein

Choose one `authenticate-request.ts` implementation below, then apply your authorization policy in
`auth.ts`. The Better Auth section shows a co-located version instead, because its adapter must reuse
the exact Better Auth instance your application already exports.

```ts
// auth.ts
import { Auth } from "@langchain/langgraph-sdk/auth";

import { authenticateRequest } from "./authenticate-request.js";

const tenantLabel = (identity: string) =>
  encodeURIComponent(identity).replace(/\./g, "%2E").replace(/\*/g, "%2A");

export const auth = new Auth()
  .authenticate(authenticateRequest)
  // A filter hides other owners' rows on reads and stamps ownership onto writes. Runs authorize
  // through their thread, and crons fall back to this handler when no crons handler is registered.
  .on("threads", ({ user }) => ({ owner: user.identity }))
  // Store items have no metadata to filter. Root their namespace instead.
  .on("store", ({ user, value }) => {
    value.namespace = [tenantLabel(user.identity), ...(value.namespace ?? []).slice(1)];
  });
```

Point `langgraph.json` at that export:

```jsonc
{
  "auth": { "path": "./src/auth.ts:auth", "disable_studio_auth": true },
}
```

Set `disable_studio_auth` to `false` only when you intentionally want LangGraph Studio traffic to
bypass your provider during development. Authentication answers _who is calling_; the `.on(...)`
handlers answer _what they may access_. Keep organization membership, roles, and other application
policy in those handlers rather than in Skein config.

Bearer-token providers can share this small helper:

```ts
// auth-helpers.ts
import { HTTPException } from "@langchain/langgraph-sdk/auth";

export function requireBearerToken(request: Request): string {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new HTTPException(401, { message: "Missing bearer token" });
  return match[1];
}
```

## Better Auth

Better Auth's server API accepts the same `Headers` object Skein gives the authentication callback.
This works with its normal session cookie; it also accepts `Authorization: Bearer ...` when you have
enabled Better Auth's [Bearer plugin](https://better-auth.com/docs/plugins/bearer).

```ts
// src/auth.ts — add `skeinAuth` beside the Better Auth instance your app already uses
import { Auth as LangGraphAuth, HTTPException } from "@langchain/langgraph-sdk/auth";
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  // Keep your existing database, providers, plugins, and session options here.
});

const tenantLabel = (identity: string) =>
  encodeURIComponent(identity).replace(/\./g, "%2E").replace(/\*/g, "%2A");

export const skeinAuth = new LangGraphAuth()
  .authenticate(async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new HTTPException(401, { message: "Unauthorized" });

    return {
      identity: session.user.id,
      display_name: session.user.name,
      email: session.user.email,
      permissions: [],
    };
  })
  .on("threads", ({ user }) => ({ owner: user.identity }))
  .on("store", ({ user, value }) => {
    value.namespace = [tenantLabel(user.identity), ...(value.namespace ?? []).slice(1)];
  });
```

This reuses your existing Better Auth instance and session store; do not create a second auth
database for Skein. Let Better Auth's own client and endpoints continue to handle login, logout, and
cookie refresh—Skein only reads the session presented on each request. See Better Auth's
[server-side session API](https://better-auth.com/docs/basic-usage#get-session).

For this variant, point `langgraph.json` at `"./src/auth.ts:skeinAuth"` so it does not confuse the
Better Auth instance with LangGraph's `Auth` instance.

## Clerk

Use Clerk's request-level verifier rather than decoding the session JWT yourself. Set
`authorizedParties` to the origins that are allowed to send Clerk credentials to this server.

```ts
// authenticate-request.ts
import { createClerkClient } from "@clerk/backend";
import { HTTPException } from "@langchain/langgraph-sdk/auth";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

export async function authenticateRequest(request: Request) {
  const requestState = await clerk.authenticateRequest(request, {
    authorizedParties: [process.env.APP_ORIGIN!],
  });
  if (!requestState.isAuthenticated) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const principal = requestState.toAuth();
  if (!principal.userId) throw new HTTPException(401, { message: "Unauthorized" });

  return {
    identity: principal.userId,
    org_id: principal.orgId,
    permissions: principal.orgPermissions ?? [],
  };
}
```

Clerk documents the full [`authenticateRequest()`
contract](https://clerk.com/docs/reference/backend/authenticate-request), including networkless
verification with `CLERK_JWT_KEY` and separate machine-token modes.

## Supabase Auth

For an API server, accept the user's Supabase access token as a bearer token and verify its claims.
`getClaims(token)` uses the project's cached JWKS when possible; unlike `getSession()`, it does not
trust client-side session storage.

```ts
// authenticate-request.ts
import { HTTPException } from "@langchain/langgraph-sdk/auth";
import { createClient } from "@supabase/supabase-js";

import { requireBearerToken } from "./auth-helpers.js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);

export async function authenticateRequest(request: Request) {
  const { data, error } = await supabase.auth.getClaims(requireBearerToken(request));
  if (error || !data || typeof data.claims.sub !== "string") {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const scope = data.claims.scope;
  return {
    identity: data.claims.sub,
    permissions: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
  };
}
```

See Supabase's [`getClaims()` reference](https://supabase.com/docs/reference/javascript/auth-getclaims).
If your project still uses an HS256 signing secret, Supabase may call its Auth server to verify each
token; do not decode the JWT without verifying it.

## Firebase Auth

The browser obtains a Firebase **ID token** after sign-in and sends it as a bearer token. Verify that
ID token with the Admin SDK; do not send or accept a Firebase custom token here.

```ts
// authenticate-request.ts
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { HTTPException } from "@langchain/langgraph-sdk/auth";

import { requireBearerToken } from "./auth-helpers.js";

const firebaseApp = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
const firebaseAuth = getAuth(firebaseApp);

export async function authenticateRequest(request: Request) {
  try {
    const token = await firebaseAuth.verifyIdToken(requireBearerToken(request));
    return { identity: token.uid, permissions: [] };
  } catch {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
}
```

Firebase's [ID-token verification guide](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
explains service-account setup and the optional revocation check. Map only custom claims you created
for authorization; do not turn every JWT claim into a permission.

## Auth0, Okta, Cognito, WorkOS, or another OIDC issuer

For a standards-based issuer, verify the access-token signature, issuer, audience, and expiry from
its JWKS. The `jose` package works across Node, Bun, and Deno:

```ts
// authenticate-request.ts
import { HTTPException } from "@langchain/langgraph-sdk/auth";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

import { requireBearerToken } from "./auth-helpers.js";

const issuer = process.env.OIDC_ISSUER!; // exact `iss`
const audience = process.env.OIDC_AUDIENCE!; // this Skein API's identifier
const issuerBase = issuer.endsWith("/") ? issuer : `${issuer}/`;
const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", issuerBase));

export async function authenticateRequest(request: Request) {
  try {
    const { payload } = await jwtVerify(requireBearerToken(request), jwks, {
      issuer,
      audience,
    });
    if (!payload.sub) throw new HTTPException(401, { message: "Unauthorized" });

    return {
      identity: payload.sub,
      permissions:
        typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
    };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof errors.JOSEError) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    throw error;
  }
}
```

Use an **access token whose audience is this API**, not an ID token meant for a browser client. Auth0,
for example, makes that distinction explicit in its [token guide](https://auth0.com/docs/secure/tokens).
Some issuers publish a discovery document at `/.well-known/openid-configuration`; use its `jwks_uri`
when it differs from the conventional path above.

## Authorization: decide what callers can access

Once a provider has proved who the caller is, stop thinking about Clerk, Firebase, or JWTs. Every
provider now reaches the same LangGraph authorization handlers with a normalized `user`:

- `user.identity` is the stable user ID.
- `user.permissions` is the trusted permission list you returned during authentication.
- Extra verified fields such as Clerk's `org_id` remain available on `user`.

An authorization handler has three useful answers:

| Return value                 | Meaning                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `false`                      | Deny with `403`                                                         |
| `true`, `null`, or no return | Allow without an ownership filter                                       |
| `{ owner: user.identity }`   | Allow and scope the resource; the filter also stamps newly created rows |
| Rewrite `value.namespace`    | Scope long-term store access                                            |

Handlers match from most specific to broadest: `threads:delete` → `threads` → `*:delete` → `*`.
That lets one sensitive action be stricter without repeating the policy for every route.

### A practical per-user policy

This is a good default for an app where every person owns their own conversations:

```ts
export const auth = new Auth()
  .authenticate(authenticateRequest)
  .on("threads:delete", ({ user }) =>
    user.permissions.includes("threads:delete") ? { owner: user.identity } : false,
  )
  .on("threads", ({ user }) =>
    user.permissions.includes("skein:admin") ? true : { owner: user.identity },
  )
  .on("assistants", ({ user }) => user.permissions.includes("assistants:read"))
  .on("store", ({ user, value }) => {
    value.namespace = [tenantLabel(user.identity), ...(value.namespace ?? []).slice(1)];
  });
```

Here an administrator can see all threads, ordinary users see only their own, deletion needs an
additional permission, and assistant discovery is explicitly gated. Returning an ownership filter
for `threads:delete` is important: returning only `true` would let any caller with that permission
delete any user's thread.

Thread policy automatically covers runs because runs belong to a thread. Crons have their own
resource, but fall back to the `threads` handler when you do not register a `crons` handler. Add an
explicit handler when scheduling is more privileged than chatting:

```ts
auth.on("crons", ({ user }) =>
  user.permissions.includes("crons:manage") ? { owner: user.identity } : false,
);
```

### Share data inside an organization

If threads belong to a Clerk organization, Auth0 organization, or your own workspace rather than one
person, authenticate the organization ID as a trusted field and filter on it consistently:

```ts
const organizationId = (user: { org_id?: unknown }) =>
  typeof user.org_id === "string" ? user.org_id : undefined;

auth
  .on("threads", ({ user }) => {
    const orgId = organizationId(user);
    return orgId ? { org_id: orgId } : false;
  })
  .on("store", ({ user, value }) => {
    const orgId = organizationId(user);
    if (!orgId) throw new HTTPException(403, { message: "Choose an organization" });
    value.namespace = [tenantLabel(orgId), ...(value.namespace ?? []).slice(1)];
  });
```

Do not accept `org_id`, `owner`, or permissions from request metadata or graph input. They must come
from provider-verified claims. Decide explicitly what a user with no active organization should do;
the example denies access instead of silently falling back to a personal tenant.

### Know which resources can be filtered

| Resource     | What authorization can do                                                               |
| ------------ | --------------------------------------------------------------------------------------- |
| `threads`    | Deny or return metadata filters; the same policy protects their runs                    |
| `crons`      | Deny or return metadata filters; falls back to `threads` when no cron handler exists    |
| `assistants` | Gate access only; graph-backed assistants are shared, so ownership filters do not apply |
| `store`      | Rewrite `value.namespace`; returning a metadata filter does not isolate store items     |

The last row is the easy one to miss: authentication alone does **not** make long-term memory
multi-tenant. Keep the namespace rewrite even if every other resource is owner-filtered. Calls to
`getStore()` from inside a graph do not pass through HTTP authorization, so build their namespace
from `config.configurable.langgraph_auth_user_id` (or another server-injected verified field), never
from model output.

## Auth.js / NextAuth

Auth.js already knows how to verify its own session. You only need a small wrapper that accepts two
functions:

- `readVerifiedSession(request)` returns your provider's verified session, or `null`.
- `toPrincipal(session)` returns the user shape Skein needs. `identity` must be a stable user ID;
  everything else is application-defined context for authorization handlers.

The wrapper returns exactly the function accepted by `.authenticate(...)`:
`(request: Request) => Promise<SkeinPrincipal>`.

```ts
import { HTTPException } from "@langchain/langgraph-sdk/auth";

type SkeinPrincipal = {
  identity: string;
  permissions: string[];
  [attribute: string]: unknown;
};

type ReadVerifiedSession<TSession> = (request: Request) => Promise<TSession | null>;
type ToPrincipal<TSession> = (session: TSession) => SkeinPrincipal;

function createSessionAuthenticator<TSession>(
  readVerifiedSession: ReadVerifiedSession<TSession>,
  toPrincipal: ToPrincipal<TSession>,
): (request: Request) => Promise<SkeinPrincipal> {
  return async (request) => {
    const session = await readVerifiedSession(request);
    if (!session) throw new HTTPException(401, { message: "Unauthorized" });

    const principal = toPrincipal(session);
    if (!principal.identity) throw new HTTPException(401, { message: "Unauthorized" });
    return principal;
  };
}
```

For example, in the same module where a Next.js app already configures Auth.js, use the exported
`auth()` session reader and map your session fields:

```ts
import { Auth as LangGraphAuth } from "@langchain/langgraph-sdk/auth";
import NextAuth, { type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      permissions?: string[];
    } & DefaultSession["user"];
  }
}

const { auth: readAuthJsSession, handlers } = NextAuth({
  providers: [GitHub],
  callbacks: {
    session({ session, token }) {
      // This example uses Auth.js's JWT session strategy. For database sessions, use `user.id`.
      if (!token.sub) throw new Error("Auth.js token is missing a user ID");
      session.user.id = token.sub;
      return session;
    },
  },
});

export { handlers };

export const skeinAuth = new LangGraphAuth()
  .authenticate(
    createSessionAuthenticator(
      async () => readAuthJsSession(),
      (session) => ({
        identity: session.user.id,
        display_name: session.user.name,
        email: session.user.email,
        permissions: session.user.permissions ?? [],
      }),
    ),
  )
  .on("threads", ({ user }) => ({ owner: user.identity }));
```

This is intentionally code you own: change only the session reader and field mapping when your
framework or session shape differs. Auth.js documents how to expose a stable user ID for [JWT and
database sessions](https://authjs.dev/guides/extending-the-session) and how to keep custom session
fields type-safe with [module augmentation](https://authjs.dev/getting-started/typescript).

If Skein runs as a separate server, the same wrapper still applies, but
`readVerifiedSession(request)` should call a trusted session-validation endpoint. Alternatively,
exchange the application session for a short-lived signed access token and use the [OIDC/JWT
recipe](#auth0-okta-cognito-workos-or-another-oidc-issuer). Do not feed an Auth.js database-session
cookie to a JWT decoder: that cookie is a lookup key, not a JWT.

## Browser cookies and CORS

Same-origin cookies need no CORS configuration. Across origins, all three pieces must agree:

1. The browser request includes credentials.
2. The auth provider issued a cookie valid for the Skein origin/domain and appropriate `SameSite` and
   `Secure` attributes.
3. Skein allows the exact frontend origin and credentials—never `*` with credentials:

```jsonc
{
  "http": {
    "cors": {
      "allow_origins": ["https://app.example.com"],
      "allow_credentials": true,
    },
  },
}
```

Bearer tokens do not require credentialed cookies, but the browser still needs the `authorization`
header allowed by its CORS preflight. Prefer same-origin mounting when your framework already hosts
the frontend.

## What Skein does after authentication

The returned object becomes `user` in every `.on(...)` callback. Skein also stamps it into graph run
config as `langgraph_auth_user`, `langgraph_auth_user_id`, and `langgraph_auth_permissions`; clients
cannot spoof those keys. Thread filters apply to runs as well. Long-term store access is separate and
must be rooted by namespace, as in the shared policy above.

For the full request lifecycle, route-to-permission map, and store-scoping traps, see
[Authentication + authorization](../agent-protocol.md#authentication--authorization).
