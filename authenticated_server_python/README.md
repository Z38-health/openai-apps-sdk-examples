# Authenticated MCP server (Python)

This example shows how to build an authenticated app with the OpenAI Apps SDK.
It demonstrates triggering the ChatGPT authentication UI by responding with MCP
authorization metadata and follows the same OAuth flow described in the MCP
authorization spec: https://modelcontextprotocol.io/docs/tutorials/security/authorization#the-authorization-flow:-step-by-step.
The Apps SDK auth guide covers how the UI is triggered: https://developers.openai.com/apps-sdk/build/auth#triggering-authentication-ui.

The server exposes two tools: `search_pizza_sf` (mixed auth, returns the
`mixed-auth-search` widget) and `see_past_orders` (OAuth required, returns a
`mixed-auth-past-orders` widget with past-order data). If a request is missing a
token for the protected tool, the server returns an `mcp/www_authenticate` hint
(backed by `WWW-Authenticate`) plus `/.well-known/oauth-protected-resource`
metadata so ChatGPT knows which authorization server to use. With a valid
token, the tools return widget markup or structured results.

## Run the app

### 1. Configure the authorization server (Auth0)

> This example uses an Auth0 tenant as a default authorization server. To set up your own, follow the instructions below:

1. **Create an API**
   - Auth0 Dashboard → *Applications* → *APIs* → *Create API*
   - Name it (e.g., `mcp-python-server`)
   - Identifier → `https://your-domain.example.com/mcp` (add this to your `JWT_AUDIENCES` environment variable)
   - (JWT) Profile → Auth0

2. **Enable a default audience for your tenant** (per [this community post](https://community.auth0.com/t/rfc-8707-implementation-audience-vs-resource/188990/4)) so that Auth0 issues an unencrypted RS256 JWT.
   - Tenant settings > Default Audience > Add the API identifier you created in step 1.

3. **Enable Dynamic Client Registration**
   - Go to Dashboard > Settings > Advanced and enable the [OIDC Dynamic Application Registration](https://auth0.com/docs/get-started/applications/dynamic-client-registration?tenant=openai-mcpkit-trial%40prod-us-5&locale=en-us).

4. **Add a social connection to the tenant** for example Google oauth2 to provide a social login mechanism for uers.
   - Authentication > Social > google-oauth2 > Advanced > Promote Connection to Domain Level

5. **Update your environment variables**
   - `AUTHORIZATION_SERVER_URL`:  your tenant domain (e.g., `https://dev-your-tenant.us.auth0.com/`)

### 2. Customize the app

- Update `RESOURCE_SERVER_URL` to point to the URL where your MCP server is deployed.
- Adjust the `WWW-Authenticate` construction or scopes to match your security
  model.
- Rebuild the widget assets (`pnpm run build`) if you change the UI.

### Prerequisites

- Python 3.10+
- A virtual environment (recommended)

#### Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

#### Running the server

In a separate terminal, from the root of the directory, build and serve the widget assets (required for the UI):

```bash
pnpm run build
pnpm run serve
```

In a separate terminal, from the `authenticated_server_python`, run the following command to bring up the MCP server:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

The server listens on `http://127.0.0.1:8000` and exposes the standard MCP
endpoint at `GET /mcp`.

The search tool echoes the optional `searchTerm` argument as a topping
and returns structured content plus widget markup. Unauthenticated calls return
the MCP auth hint so the Apps SDK can start the OAuth flow.
