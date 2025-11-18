"""Pizzaz demo MCP server implemented with the Python FastMCP helper.

The server mirrors the Node example in this repository and exposes
widget-backed tools that render the Pizzaz UI bundle. Each handler returns the
HTML shell via an MCP resource and echoes the selected topping as structured
content so the ChatGPT client can hydrate the widget. The module also wires the
handlers into an HTTP/SSE stack so you can run the server with uvicorn on port
8000, matching the Node transport behavior."""

from __future__ import annotations

import json
import os
from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List
from urllib.parse import urlparse

import mcp.types as types
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.fastmcp import FastMCP
from mcp.shared.auth import ProtectedResourceMetadata
from pydantic import AnyHttpUrl
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


class SimpleTokenVerifier(TokenVerifier):
    """Development helper that blindly accepts any token."""

    def __init__(self, required_scopes: Iterable[str]):
        self.required_scopes: list[str] = list(required_scopes)

    async def verify_token(
        self, token: str
    ) -> (
        AccessToken | None
    ):  # TODO: Do not use in production—replace with a real verifier.
        return AccessToken(
            token=token or "dev_token",
            client_id="dev_client",
            subject="dev",
            scopes=self.required_scopes or [],
            claims={"debug": True},
        )


@dataclass(frozen=True)
class PizzazWidget:
    identifier: str
    title: str
    template_uri: str
    invoking: str
    invoked: str
    html: str
    response_text: str


ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
ECOMMERCE_SAMPLE_DATA_PATH = (
    Path(__file__).resolve().parent.parent
    / "ecommerce_server_python"
    / "sample_data.json"
)
MATCHA_PIZZA_IMAGE = "https://persistent.oaistatic.com/pizzaz-cart-xl/matcha-pizza.png"
DEFAULT_CART_ITEMS: List[Dict[str, Any]] = [
    {"id": "matcha-pizza", "image": MATCHA_PIZZA_IMAGE, "quantity": 1}
]


@lru_cache(maxsize=None)
def _load_widget_html(component_name: str) -> str:
    html_path = ASSETS_DIR / f"{component_name}.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf8")

    fallback_candidates = sorted(ASSETS_DIR.glob(f"{component_name}-*.html"))
    if fallback_candidates:
        return fallback_candidates[-1].read_text(encoding="utf8")

    raise FileNotFoundError(
        f'Widget HTML for "{component_name}" not found in {ASSETS_DIR}. '
        "Run `pnpm run build` to generate the assets before starting the server."
    )


@lru_cache(maxsize=1)
def _load_ecommerce_cart_items() -> List[Dict[str, Any]]:
    if not ECOMMERCE_SAMPLE_DATA_PATH.exists():
        return [deepcopy(item) for item in DEFAULT_CART_ITEMS]

    try:
        raw = json.loads(ECOMMERCE_SAMPLE_DATA_PATH.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return [deepcopy(item) for item in DEFAULT_CART_ITEMS]

    items: List[Dict[str, Any]] = []
    for entry in raw.get("products", []):
        if not isinstance(entry, dict):
            continue
        sanitized = _sanitize_cart_item(entry)
        if sanitized:
            items.append(sanitized)

    return items or [deepcopy(item) for item in DEFAULT_CART_ITEMS]


def _sanitize_cart_item(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    identifier = str(entry.get("id", "")).strip()
    if not identifier:
        return None

    image_candidate = str(entry.get("image", "")).strip()
    image = image_candidate or MATCHA_PIZZA_IMAGE

    quantity_raw = entry.get("quantity", 0)
    try:
        quantity = int(quantity_raw)
    except (TypeError, ValueError):
        quantity = 0

    return {
        "id": identifier,
        "image": image,
        "quantity": max(0, quantity),
    }


def _product_matches_search(item: Dict[str, Any], search_term: str) -> bool:
    """Return True if the product matches the provided search term."""
    term = search_term.strip().lower()
    if not term:
        return True

    identifier = str(item.get("id", "")).lower()
    return term in identifier


ECOMMERCE_WIDGET = PizzazWidget(
    identifier="pizzaz-ecommerce",
    title="Show Ecommerce Catalog",
    template_uri="ui://widget/ecommerce.html",
    invoking="Loading the ecommerce catalog",
    invoked="Ecommerce catalog ready",
    html=_load_widget_html("ecommerce"),
    response_text="Rendered the ecommerce catalog!",
)


MIME_TYPE = "text/html+skybridge"

SEARCH_TOOL_NAME = ECOMMERCE_WIDGET.identifier
INCREMENT_TOOL_NAME = "increment_item"

SEARCH_TOOL_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "title": "Product search terms",
    "properties": {
        "searchTerm": {
            "type": "string",
            "description": "Optional text to match against the product ID (only the Matcha Pizza item is available).",
        },
    },
    "required": [],
    "additionalProperties": False,
}

INCREMENT_TOOL_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "title": "Increment cart item",
    "properties": {
        "productId": {
            "type": "string",
            "description": "Product ID from the catalog to increment.",
        },
        "incrementBy": {
            "type": "integer",
            "minimum": 1,
            "default": 1,
            "description": "How many units to add to the product quantity (defaults to 1).",
        },
    },
    "required": ["productId"],
    "additionalProperties": False,
}

DEFAULT_AUTH_SERVER_URL = "https://dev-65wmmp5d56ev40iy.us.auth0.com/"
DEFAULT_RESOURCE_SERVER_URL = "http://localhost:8000/mcp"

# Public URLs that describe this resource server plus the authorization server.
AUTHORIZATION_SERVER_URL = AnyHttpUrl(
    os.environ.get("AUTHORIZATION_SERVER_URL", DEFAULT_AUTH_SERVER_URL)
)
RESOURCE_SERVER_URL = "https://5fb2bf13c559.ngrok-free.app"
RESOURCE_SCOPES = ["cart.write"]

_parsed_resource_url = urlparse(str(RESOURCE_SERVER_URL))
_resource_path = (
    _parsed_resource_url.path if _parsed_resource_url.path not in ("", "/") else ""
)
PROTECTED_RESOURCE_METADATA_PATH = (
    f"/.well-known/oauth-protected-resource{_resource_path}"
)
PROTECTED_RESOURCE_METADATA_URL = f"{_parsed_resource_url.scheme}://{_parsed_resource_url.netloc}{PROTECTED_RESOURCE_METADATA_PATH}"

print("PROTECTED_RESOURCE_METADATA_URL", PROTECTED_RESOURCE_METADATA_URL)
PROTECTED_RESOURCE_METADATA = ProtectedResourceMetadata(
    resource=RESOURCE_SERVER_URL,
    authorization_servers=[AUTHORIZATION_SERVER_URL],
    scopes_supported=RESOURCE_SCOPES,
)

# Tool-level securitySchemes inform ChatGPT when OAuth is required for a call.
PUBLIC_TOOL_SECURITY_SCHEMES = [{"type": "noauth"}]
INCREMENT_TOOL_SECURITY_SCHEMES = [
    {
        "type": "oauth2",
        "scopes": ["cart.write"],
    }
]


mcp = FastMCP(
    name="pizzaz-python",
    stateless_http=True,
)


@mcp.custom_route(PROTECTED_RESOURCE_METADATA_PATH, methods=["GET", "OPTIONS"])
async def protected_resource_metadata(request: Request) -> Response:
    """Expose RFC 9728 metadata so clients can find the Auth0 authorization server."""
    if request.method == "OPTIONS":
        return Response(status_code=204)
    return JSONResponse(PROTECTED_RESOURCE_METADATA.model_dump(mode="json"))


def _resource_description(widget: PizzazWidget) -> str:
    return f"{widget.title} widget markup"


def _tool_meta(
    widget: PizzazWidget,
    security_schemes: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    meta = {
        "openai/outputTemplate": widget.template_uri,
        "openai/toolInvocation/invoking": widget.invoking,
        "openai/toolInvocation/invoked": widget.invoked,
        "openai/widgetAccessible": True,
        "openai/resultCanProduceWidget": True,
    }
    if security_schemes is not None:
        meta["securitySchemes"] = deepcopy(security_schemes)
    return meta


def _tool_invocation_meta(widget: PizzazWidget) -> Dict[str, Any]:
    return {
        "openai/toolInvocation/invoking": widget.invoking,
        "openai/toolInvocation/invoked": widget.invoked,
        "openai/widgetSessionId": "ren-test-session-id",
    }


def _resource_metadata_url() -> str | None:
    auth_config = getattr(mcp.settings, "auth", None)
    if auth_config and auth_config.resource_server_url:
        parsed = urlparse(str(auth_config.resource_server_url))
        resource_path = parsed.path if parsed.path not in ("", "/") else ""
        return f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-protected-resource{resource_path}"
    print("PROTECTED_RESOURCE_METADATA_URL", PROTECTED_RESOURCE_METADATA_URL)
    return PROTECTED_RESOURCE_METADATA_URL


def _build_www_authenticate_value(error: str, description: str) -> str:
    safe_error = error.replace('"', r"\"")
    safe_description = description.replace('"', r"\"")
    parts = [
        f'error="{safe_error}"',
        f'error_description="{safe_description}"',
    ]
    resource_metadata = _resource_metadata_url()
    if resource_metadata:
        parts.append(f'resource_metadata="{resource_metadata}"')
    return f"Bearer {', '.join(parts)}"


def _oauth_error_result(
    user_message: str,
    *,
    error: str = "invalid_request",
    description: str | None = None,
) -> types.ServerResult:
    description_text = description or user_message
    return types.ServerResult(
        types.CallToolResult(
            content=[
                types.TextContent(
                    type="text",
                    text=user_message,
                )
            ],
            _meta={
                "mcp/www_authenticate": [
                    _build_www_authenticate_value(error, description_text)
                ]
            },
            isError=True,
        )
    )


def _get_bearer_token_from_request() -> str | None:
    try:
        request_context = mcp._mcp_server.request_context
    except LookupError:
        return None

    request = getattr(request_context, "request", None)
    if request is None:
        return None

    header_value: Any = None
    headers = getattr(request, "headers", None)
    if headers is not None:
        try:
            header_value = headers.get("authorization")
            if header_value is None:
                header_value = headers.get("Authorization")
        except Exception:
            header_value = None

    if header_value is None:
        # Attempt to read from ASGI scope headers if available
        scope = getattr(request, "scope", None)
        scope_headers = scope.get("headers") if isinstance(scope, dict) else None
        if scope_headers:
            for key, value in scope_headers:
                decoded_key = (
                    key.decode("latin-1")
                    if isinstance(key, (bytes, bytearray))
                    else str(key)
                ).lower()
                if decoded_key == "authorization":
                    header_value = (
                        value.decode("latin-1")
                        if isinstance(value, (bytes, bytearray))
                        else str(value)
                    )
                    break

    if header_value is None and isinstance(request, dict):
        # Fall back to dictionary-like request contexts
        raw_value = request.get("authorization") or request.get("Authorization")
        header_value = raw_value

    if header_value is None:
        return None

    if isinstance(header_value, (bytes, bytearray)):
        header_value = header_value.decode("latin-1")

    header_value = header_value.strip()
    if not header_value.lower().startswith("bearer "):
        return None

    token = header_value[7:].strip()
    return token or None


@mcp._mcp_server.list_tools()
async def _list_tools() -> List[types.Tool]:
    public_tool_meta = _tool_meta(ECOMMERCE_WIDGET, PUBLIC_TOOL_SECURITY_SCHEMES)
    increment_tool_meta = _tool_meta(ECOMMERCE_WIDGET, INCREMENT_TOOL_SECURITY_SCHEMES)
    return [
        types.Tool(
            name=SEARCH_TOOL_NAME,
            title=ECOMMERCE_WIDGET.title,
            description="Search the ecommerce catalog using free-text keywords.",
            inputSchema=SEARCH_TOOL_SCHEMA,
            _meta=public_tool_meta,
            securitySchemes=list(PUBLIC_TOOL_SECURITY_SCHEMES),
            # To disable the approval prompt for the tools
            annotations={
                "destructiveHint": False,
                "openWorldHint": False,
                "readOnlyHint": True,
            },
        ),
        types.Tool(
            name=INCREMENT_TOOL_NAME,
            title="Increment Cart Item",
            description="Increase the quantity of an item already in the cart.",
            inputSchema=INCREMENT_TOOL_SCHEMA,
            _meta=increment_tool_meta,
            securitySchemes=list(INCREMENT_TOOL_SECURITY_SCHEMES),
            # To disable the approval prompt for the tools
            annotations={
                "destructiveHint": False,
                "openWorldHint": False,
                "readOnlyHint": True,
            },
        ),
    ]


@mcp._mcp_server.list_resources()
async def _list_resources() -> List[types.Resource]:
    return [
        types.Resource(
            name=ECOMMERCE_WIDGET.title,
            title=ECOMMERCE_WIDGET.title,
            uri=ECOMMERCE_WIDGET.template_uri,
            description=_resource_description(ECOMMERCE_WIDGET),
            mimeType=MIME_TYPE,
            _meta=_tool_meta(ECOMMERCE_WIDGET),
        )
    ]


@mcp._mcp_server.list_resource_templates()
async def _list_resource_templates() -> List[types.ResourceTemplate]:
    return [
        types.ResourceTemplate(
            name=ECOMMERCE_WIDGET.title,
            title=ECOMMERCE_WIDGET.title,
            uriTemplate=ECOMMERCE_WIDGET.template_uri,
            description=_resource_description(ECOMMERCE_WIDGET),
            mimeType=MIME_TYPE,
            _meta=_tool_meta(ECOMMERCE_WIDGET),
        )
    ]


async def _handle_read_resource(req: types.ReadResourceRequest) -> types.ServerResult:
    requested_uri = str(req.params.uri)
    if requested_uri != ECOMMERCE_WIDGET.template_uri:
        return types.ServerResult(
            types.ReadResourceResult(
                contents=[],
                _meta={"error": f"Unknown resource: {req.params.uri}"},
            )
        )

    contents = [
        types.TextResourceContents(
            uri=ECOMMERCE_WIDGET.template_uri,
            mimeType=MIME_TYPE,
            text=ECOMMERCE_WIDGET.html,
            _meta=_tool_meta(ECOMMERCE_WIDGET),
        )
    ]

    return types.ServerResult(types.ReadResourceResult(contents=contents))


async def _call_tool_request(req: types.CallToolRequest) -> types.ServerResult:
    tool_name = req.params.name
    if tool_name not in {SEARCH_TOOL_NAME, INCREMENT_TOOL_NAME}:
        return types.ServerResult(
            types.CallToolResult(
                content=[
                    types.TextContent(
                        type="text",
                        text=f"Unknown tool: {req.params.name}",
                    )
                ],
                isError=True,
            )
        )

    arguments = req.params.arguments or {}
    meta = _tool_invocation_meta(ECOMMERCE_WIDGET)
    cart_items = [deepcopy(item) for item in _load_ecommerce_cart_items()]

    if tool_name == SEARCH_TOOL_NAME:
        search_term = str(arguments.get("searchTerm", "")).strip()
        filtered_items = cart_items
        if search_term:
            filtered_items = [
                item
                for item in cart_items
                if _product_matches_search(item, search_term)
            ]
        structured_content: Dict[str, Any] = {
            "cartItems": filtered_items,
            "searchTerm": search_term,
            "toolCallName": SEARCH_TOOL_NAME,
        }
        response_text = ECOMMERCE_WIDGET.response_text
    else:
        if not _get_bearer_token_from_request():
            return _oauth_error_result(
                "Authentication required: no access token provided.",
                description="No access token was provided",
            )
        product_id = str(arguments.get("productId", "")).strip()
        if not product_id:
            return types.ServerResult(
                types.CallToolResult(
                    content=[
                        types.TextContent(
                            type="text",
                            text="productId is required to increment a cart item.",
                        )
                    ],
                    isError=True,
                )
            )

        increment_raw = arguments.get("incrementBy", 1)
        try:
            increment_by = int(increment_raw)
        except (TypeError, ValueError):
            return types.ServerResult(
                types.CallToolResult(
                    content=[
                        types.TextContent(
                            type="text",
                            text="incrementBy must be an integer.",
                        )
                    ],
                    isError=True,
                )
            )

        if increment_by < 1:
            return types.ServerResult(
                types.CallToolResult(
                    content=[
                        types.TextContent(
                            type="text",
                            text="incrementBy must be at least 1.",
                        )
                    ],
                    isError=True,
                )
            )

        product = next(
            (item for item in cart_items if item.get("id") == product_id),
            None,
        )
        if product is None:
            return types.ServerResult(
                types.CallToolResult(
                    content=[
                        types.TextContent(
                            type="text",
                            text=f"Product '{product_id}' was not found in the cart.",
                        )
                    ],
                    isError=True,
                )
            )

        current_quantity_raw = product.get("quantity", 0)
        try:
            current_quantity = int(current_quantity_raw)
        except (TypeError, ValueError):
            current_quantity = 0
        product["quantity"] = current_quantity + increment_by

        structured_content = {"toolCallName": INCREMENT_TOOL_NAME}
        product_name = product.get("id", product_id)
        response_text = (
            f"Incremented {product_name} by {increment_by}. Updated cart ready."
        )

    return types.ServerResult(
        types.CallToolResult(
            content=[
                types.TextContent(
                    type="text",
                    text=response_text,
                )
            ],
            structuredContent=structured_content,
            _meta=meta,
        )
    )


mcp._mcp_server.request_handlers[types.CallToolRequest] = _call_tool_request
mcp._mcp_server.request_handlers[types.ReadResourceRequest] = _handle_read_resource


app = mcp.streamable_http_app()

try:
    from starlette.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
except Exception:
    pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000)
