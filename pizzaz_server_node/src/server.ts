import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type PizzazWidget = {
  id: string;
  title: string;
  templateUri: string;
  invoking: string;
  invoked: string;
  componentName: string;
  responseText: string;
};

type PizzaPlace = {
  id: string;
  name: string;
  neighborhood: string;
  description: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

const pizzaPlaces: PizzaPlace[] = [
  {
    id: "best-slice",
    name: "Best Slice",
    neighborhood: "Downtown",
    description: "Classic New York style slices and late-night hours.",
  },
  {
    id: "wood-fired-co",
    name: "Wood Fired Co.",
    neighborhood: "Riverside",
    description: "Neapolitan pizzas with seasonal toppings and a great crust.",
  },
  {
    id: "deep-dish-den",
    name: "Deep Dish Den",
    neighborhood: "Uptown",
    description: "Chicago-inspired deep dish, cheesy and hearty.",
  },
];

function placeUri(placeId: string) {
  return `pizzaz://place/${encodeURIComponent(placeId)}`;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function readWidgetHtml(componentName: string, assetsBaseUrlOverride?: string): string {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(
      `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "pnpm run build" before starting the server.`
    );
  }

  const directPath = path.join(ASSETS_DIR, `${componentName}.html`);
  let htmlContents: string | null = null;

  if (fs.existsSync(directPath)) {
    htmlContents = fs.readFileSync(directPath, "utf8");
  } else {
    const candidates = fs
      .readdirSync(ASSETS_DIR)
      .filter(
        (file) => file.startsWith(`${componentName}-`) && file.endsWith(".html")
      )
      .sort();
    const fallback = candidates[candidates.length - 1];
    if (fallback) {
      htmlContents = fs.readFileSync(path.join(ASSETS_DIR, fallback), "utf8");
    }
  }

  if (!htmlContents) {
    throw new Error(
      `Widget HTML for "${componentName}" not found in ${ASSETS_DIR}. Run "pnpm run build" to generate the assets.`
    );
  }

  // Prefer `BASE_URL` (as documented in the repo README), but accept `ASSETS_BASE_URL`
  // for backwards compatibility with earlier iterations.
  const assetsBaseUrlRaw =
    process.env.BASE_URL ?? process.env.ASSETS_BASE_URL ?? assetsBaseUrlOverride;

  if (assetsBaseUrlRaw) {
    const assetsBaseUrl = normalizeBaseUrl(assetsBaseUrlRaw);
    // When using quick tunnels (or any changing asset host), the built HTML may have
    // hardcoded absolute URLs. Rewrite them at serve-time so we don't need to rebuild
    // on every tunnel refresh.
    htmlContents = htmlContents
      .replace(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com/gi, assetsBaseUrl)
      .replace(/http:\/\/localhost:4444/gi, assetsBaseUrl)
      // Also rewrite root-relative asset URLs to absolute, since the widget HTML is
      // delivered as `ui://...` and may not resolve `/...` against the connector origin.
      .replace(
        /(src|href)="\/([^"]+)"/gi,
        (_match, attr, filePath) => `${attr}="${assetsBaseUrl}/${filePath}"`
      );
  }

  return htmlContents;
}

function widgetDescriptorMeta(widget: PizzazWidget) {
  return {
    "openai/outputTemplate": widget.templateUri,
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
    "openai/widgetAccessible": true,
  } as const;
}

function widgetInvocationMeta(widget: PizzazWidget) {
  return {
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
  } as const;
}

const widgets: PizzazWidget[] = [
  {
    id: "pizza-map",
    title: "Show Pizza Map",
    templateUri: "ui://widget/pizza-map.html",
    invoking: "Hand-tossing a map",
    invoked: "Served a fresh map",
    componentName: "pizzaz",
    responseText: "Rendered a pizza map!",
  },
  {
    id: "pizza-carousel",
    title: "Show Pizza Carousel",
    templateUri: "ui://widget/pizza-carousel.html",
    invoking: "Carousel some spots",
    invoked: "Served a fresh carousel",
    componentName: "pizzaz-carousel",
    responseText: "Rendered a pizza carousel!",
  },
  {
    id: "pizza-albums",
    title: "Show Pizza Album",
    templateUri: "ui://widget/pizza-albums.html",
    invoking: "Hand-tossing an album",
    invoked: "Served a fresh album",
    componentName: "pizzaz-albums",
    responseText: "Rendered a pizza album!",
  },
  {
    id: "pizza-list",
    title: "Show Pizza List",
    templateUri: "ui://widget/pizza-list.html",
    invoking: "Hand-tossing a list",
    invoked: "Served a fresh list",
    componentName: "pizzaz-list",
    responseText: "Rendered a pizza list!",
  },
  {
    id: "pizza-shop",
    title: "Open Pizzaz Shop",
    templateUri: "ui://widget/pizza-shop.html",
    invoking: "Opening the shop",
    invoked: "Shop opened",
    componentName: "pizzaz-shop",
    responseText: "Rendered the Pizzaz shop!",
  },
];

let lastSeenPublicBaseUrl: string | null = null;

function inferPublicBaseUrl(req: IncomingMessage) {
  const hostHeader = req.headers["x-forwarded-host"] ?? req.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) return null;

  const protoHeader = req.headers["x-forwarded-proto"];
  const protoRaw = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  const proto = protoRaw ?? "http";

  return `${proto}://${host}`;
}

function isLocalhostHost(host: string) {
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("0.0.0.0")
  );
}

function maybeUpdateLastSeenPublicBaseUrl(req: IncomingMessage) {
  const baseUrl = inferPublicBaseUrl(req);
  if (!baseUrl) return;

  try {
    const parsed = new URL(baseUrl);
    if (isLocalhostHost(parsed.host)) {
      // Don't overwrite a public tunnel URL with localhost.
      return;
    }
    lastSeenPublicBaseUrl = parsed.origin;
  } catch {
    // ignore invalid base url
  }
}

function getWidgetHtml(widget: PizzazWidget) {
  const fallbackLocal = `http://localhost:${port}`;
  const baseUrl =
    process.env.BASE_URL ??
    process.env.ASSETS_BASE_URL ??
    lastSeenPublicBaseUrl ??
    fallbackLocal;
  return readWidgetHtml(widget.componentName, baseUrl);
}

const widgetsById = new Map<string, PizzazWidget>();
const widgetsByUri = new Map<string, PizzazWidget>();

widgets.forEach((widget) => {
  widgetsById.set(widget.id, widget);
  widgetsByUri.set(widget.templateUri, widget);
});

const toolInputSchema = {
  type: "object",
  properties: {
    pizzaTopping: {
      type: "string",
      description: "Topping to mention when rendering the widget.",
    },
  },
  required: ["pizzaTopping"],
  additionalProperties: false,
} as const;

const toolInputParser = z.object({
  pizzaTopping: z.string(),
});

const searchToolInputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Free-text query to search pizza places.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const searchToolInputParser = z.object({
  query: z.string(),
});

const fetchToolInputSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Identifier to fetch (for this demo, pass a full URI like pizzaz://place/best-slice or ui://widget/pizza-map.html).",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const fetchToolInputParser = z.object({
  id: z.string(),
});

// A minimal "search" tool makes this MCP server qualify as a retrievable connector
// in ChatGPT conformance checks (otherwise it reports "search action not found").
const searchTool: Tool = {
  name: "search",
  title: "Search",
  description: "Search for pizza places (retrievable connector entrypoint).",
  inputSchema: searchToolInputSchema,
  annotations: {
    destructiveHint: false,
    openWorldHint: false,
    readOnlyHint: true,
  },
};

// "fetch" is the corresponding follow-up action some clients expect for retrievable connectors.
const fetchTool: Tool = {
  name: "fetch",
  title: "Fetch",
  description: "Fetch a URI (retrievable connector follow-up).",
  inputSchema: fetchToolInputSchema,
  annotations: {
    destructiveHint: false,
    openWorldHint: false,
    readOnlyHint: true,
  },
};

const widgetTools: Tool[] = widgets.map((widget) => ({
  name: widget.id,
  description: widget.title,
  inputSchema: toolInputSchema,
  title: widget.title,
  _meta: widgetDescriptorMeta(widget),
  // To disable the approval prompt for the widgets
  annotations: {
    destructiveHint: false,
    openWorldHint: false,
    readOnlyHint: true,
  },
}));

const tools: Tool[] = [searchTool, fetchTool, ...widgetTools];

const widgetResources: Resource[] = widgets.map((widget) => ({
  uri: widget.templateUri,
  name: widget.title,
  description: `${widget.title} widget markup`,
  mimeType: "text/html+skybridge",
  _meta: widgetDescriptorMeta(widget),
}));

const placeResources: Resource[] = pizzaPlaces.map((place) => ({
  uri: placeUri(place.id),
  name: place.name,
  description: `${place.neighborhood} — ${place.description}`,
  mimeType: "text/plain",
}));

const resources: Resource[] = [...widgetResources, ...placeResources];

const widgetResourceTemplates: ResourceTemplate[] = widgets.map((widget) => ({
  uriTemplate: widget.templateUri,
  name: widget.title,
  description: `${widget.title} widget markup`,
  mimeType: "text/html+skybridge",
  _meta: widgetDescriptorMeta(widget),
}));

const placeResourceTemplates: ResourceTemplate[] = pizzaPlaces.map((place) => ({
  uriTemplate: placeUri(place.id),
  name: place.name,
  description: `${place.neighborhood} — ${place.description}`,
  mimeType: "text/plain",
}));

const resourceTemplates: ResourceTemplate[] = [
  ...widgetResourceTemplates,
  ...placeResourceTemplates,
];

function searchPlaces(queryRaw: string) {
  const query = queryRaw.trim().toLowerCase();
  if (!query) return [];
  return pizzaPlaces.filter((p) => {
    const haystack = `${p.name} ${p.neighborhood} ${p.description}`.toLowerCase();
    return haystack.includes(query);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

function jsonRpcResponse(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleHttpJsonRpc(req: IncomingMessage, res: ServerResponse) {
  // Minimal JSON-RPC over HTTP transport for clients that don't use SSE (e.g. some playground flows).
  // This is intentionally stateless per request.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify(jsonRpcError(null, -32700, "Invalid JSON")));
    return;
  }

  const requests = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];

  const responses: any[] = [];

  for (const rpc of requests) {
    const method = rpc?.method;
    const id = rpc?.id ?? null;

    try {
      switch (method) {
        case "initialize": {
          responses.push(
            jsonRpcResponse(id, {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "pizzaz-node", version: "0.1.0" },
              capabilities: { tools: {}, resources: {}, resourceTemplates: {} },
            })
          );
          break;
        }
        case "ping": {
          responses.push(jsonRpcResponse(id, {}));
          break;
        }
        case "tools/list": {
          responses.push(jsonRpcResponse(id, { tools }));
          break;
        }
        case "tools/call": {
          const name = rpc?.params?.name;
          const args = rpc?.params?.arguments ?? {};
          if (name === "search") {
            const parsed = searchToolInputParser.parse(args);
            const matches = searchPlaces(parsed.query);
            responses.push(
              jsonRpcResponse(id, {
                content: matches.length
                  ? matches.map((place) => ({
                      type: "resource_link",
                      name: place.name,
                      uri: placeUri(place.id),
                      description: `${place.neighborhood} — ${place.description}`,
                      mimeType: "text/plain",
                    }))
                  : [
                      {
                        type: "text",
                        text: "No matches.",
                      },
                    ],
              })
            );
            break;
          }

          if (name === "fetch") {
            const parsed = fetchToolInputParser.parse(args);
            const id = parsed.id;
            const uri = id.includes("://") ? id : placeUri(id);

            const widget = widgetsByUri.get(uri);
            if (widget) {
              responses.push(
                jsonRpcResponse(id, {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: widget.templateUri,
                        mimeType: "text/html+skybridge",
                        text: getWidgetHtml(widget),
                        _meta: widgetDescriptorMeta(widget),
                      },
                    },
                  ],
                })
              );
              break;
            }

            const place = pizzaPlaces.find((p) => placeUri(p.id) === uri);
            if (!place) throw new Error(`Unknown resource: ${uri}`);
            responses.push(
              jsonRpcResponse(id, {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri,
                      mimeType: "text/plain",
                      text: `${place.name} (${place.neighborhood})\n\n${place.description}`,
                    },
                  },
                ],
              })
            );
            break;
          }

          const widget = widgetsById.get(name);
          if (!widget) throw new Error(`Unknown tool: ${name}`);
          const parsed = toolInputParser.parse(args);
          responses.push(
            jsonRpcResponse(id, {
              content: [{ type: "text", text: widget.responseText }],
              structuredContent: { pizzaTopping: parsed.pizzaTopping },
              _meta: widgetInvocationMeta(widget),
            })
          );
          break;
        }
        case "resources/list": {
          responses.push(jsonRpcResponse(id, { resources }));
          break;
        }
        case "resources/templates/list": {
          responses.push(jsonRpcResponse(id, { resourceTemplates }));
          break;
        }
        case "resources/read": {
          const uri = rpc?.params?.uri;
          const widget = widgetsByUri.get(uri);
          if (widget) {
            responses.push(
              jsonRpcResponse(id, {
                contents: [
                  {
                    uri: widget.templateUri,
                    mimeType: "text/html+skybridge",
                    text: getWidgetHtml(widget),
                    _meta: widgetDescriptorMeta(widget),
                  },
                ],
              })
            );
            break;
          }

          const place = pizzaPlaces.find((p) => placeUri(p.id) === uri);
          if (!place) throw new Error(`Unknown resource: ${uri}`);
          responses.push(
            jsonRpcResponse(id, {
              contents: [
                {
                  uri,
                  mimeType: "text/plain",
                  text: `${place.name} (${place.neighborhood})\n\n${place.description}`,
                },
              ],
            })
          );
          break;
        }
        default: {
          responses.push(jsonRpcError(id, -32601, `Method not found: ${String(method)}`));
        }
      }
    } catch (error: any) {
      const message = error?.message ?? "Internal error";
      responses.push(jsonRpcError(id, -32000, message));
    }
  }

  res
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
}

function createPizzazServer(): Server {
  const server = new Server(
    {
      name: "pizzaz-node",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources,
    })
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => {
      const widget = widgetsByUri.get(request.params.uri);

      if (widget) {
        return {
          contents: [
            {
              uri: widget.templateUri,
              mimeType: "text/html+skybridge",
              text: getWidgetHtml(widget),
              _meta: widgetDescriptorMeta(widget),
            },
          ],
        };
      }

      const place = pizzaPlaces.find((p) => placeUri(p.id) === request.params.uri);
      if (!place) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/plain",
            text: `${place.name} (${place.neighborhood})\n\n${place.description}`,
          },
        ],
      };
    }
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({
      resourceTemplates,
    })
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({
      tools,
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      if (request.params.name === "search") {
        const parsed = searchToolInputParser.parse(request.params.arguments ?? {});
        const matches = searchPlaces(parsed.query);
        return {
          content: matches.length
            ? matches.map((place) => ({
                type: "resource_link" as const,
                name: place.name,
                uri: placeUri(place.id),
                description: `${place.neighborhood} — ${place.description}`,
                mimeType: "text/plain",
              }))
            : [
                {
                  type: "text" as const,
                  text: "No matches.",
                },
              ],
        };
      }

      if (request.params.name === "fetch") {
        const parsed = fetchToolInputParser.parse(request.params.arguments ?? {});
        const id = parsed.id;
        const uri = id.includes("://") ? id : placeUri(id);

        const widget = widgetsByUri.get(uri);
        if (widget) {
          return {
            content: [
              {
                type: "resource" as const,
                resource: {
                  uri: widget.templateUri,
                  mimeType: "text/html+skybridge",
                  text: getWidgetHtml(widget),
                  _meta: widgetDescriptorMeta(widget),
                },
              },
            ],
          };
        }

        const place = pizzaPlaces.find((p) => placeUri(p.id) === uri);
        if (!place) {
          throw new Error(`Unknown resource: ${uri}`);
        }

        return {
          content: [
            {
              type: "resource" as const,
              resource: {
                uri,
                mimeType: "text/plain",
                text: `${place.name} (${place.neighborhood})\n\n${place.description}`,
              },
            },
          ],
        };
      }

      const widget = widgetsById.get(request.params.name);

      if (!widget) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const args = toolInputParser.parse(request.params.arguments ?? {});

      return {
        content: [
          {
            type: "text",
            text: widget.responseText,
          },
        ],
        structuredContent: {
          pizzaTopping: args.pizzaTopping,
        },
        _meta: widgetInvocationMeta(widget),
      };
    }
  );

  return server;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
};

const sessions = new Map<string, SessionRecord>();

const ssePath = "/mcp";
const postPath = "/mcp/messages";

function logRequest(req: IncomingMessage, url: URL, extra?: Record<string, unknown>) {
  const ua = req.headers["user-agent"] ?? "";
  const cfRay = req.headers["cf-ray"] ?? "";
  const now = new Date().toISOString();
  const base = `[${now}] ${req.method ?? "?"} ${url.pathname}${url.search ?? ""}`;
  const parts = [
    `ua=${JSON.stringify(ua)}`,
    cfRay ? `cf-ray=${JSON.stringify(cfRay)}` : null,
    extra ? `extra=${JSON.stringify(extra)}` : null,
  ].filter(Boolean);
  console.log(`${base} ${parts.join(" ")}`);
}

function attachResponseLog(req: IncomingMessage, url: URL, res: ServerResponse) {
  const start = Date.now();
  const method = req.method ?? "?";
  const path = `${url.pathname}${url.search ?? ""}`;
  res.once("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${method} ${path} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  res.once("close", () => {
    if (!res.writableEnded) {
      console.log(
        `[${new Date().toISOString()}] ${method} ${path} -> closed (${Date.now() - start}ms)`
      );
    }
  });
}

async function handleSseRequest(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Some proxies (incl. Cloudflare) may buffer small SSE payloads until enough data is sent.
  // Tell reverse proxies not to buffer.
  res.setHeader("X-Accel-Buffering", "no");
  const server = createPizzazServer();
  const transport = new SSEServerTransport(postPath, res);
  const sessionId = transport.sessionId;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  sessions.set(sessionId, { server, transport });

  transport.onclose = async () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    sessions.delete(sessionId);
    await server.close();
  };

  transport.onerror = (error) => {
    console.error("SSE transport error", error);
  };

  try {
    await server.connect(transport);
    // After connect(), the transport has written the SSE headers + endpoint event.
    // Now send padding to defeat buffering thresholds (e.g. Cloudflare/HTTP2), which
    // helps the client receive the initial endpoint event promptly.
    res.write(`:${" ".repeat(32 * 1024)}\n\n`);
    // Keep-alive comments help some proxies keep the stream flowing.
    keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) res.write(":\n\n");
    }, 15_000);
  } catch (error) {
    sessions.delete(sessionId);
    console.error("Failed to start SSE session", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to process message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const portEnv = Number(process.env.PORT ?? 8000);
const port = Number.isFinite(portEnv) ? portEnv : 8000;

function isSafeAssetPath(urlPathname: string) {
  // Prevent path traversal. Only allow plain filenames and subpaths without "..".
  // (We still resolve and validate below before reading.)
  return !urlPathname.includes("..") && !urlPathname.includes("\\");
}

function contentTypeForFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    attachResponseLog(req, url, res);
    maybeUpdateLastSeenPublicBaseUrl(req);

    if (
      req.method === "OPTIONS" &&
      (url.pathname === ssePath || url.pathname === postPath || url.pathname === ssePath)
    ) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }

    // HTTP JSON-RPC transport (non-SSE)
    if (req.method === "POST" && url.pathname === ssePath) {
      logRequest(req, url, { kind: "http-jsonrpc" });
      await handleHttpJsonRpc(req, res);
      return;
    }

    // Some clients validate the SSE endpoint with HEAD before opening a streaming GET.
    // Return the same headers they'd see on a GET, without creating a session.
    if (req.method === "HEAD" && url.pathname === ssePath) {
      logRequest(req, url, { kind: "head-sse" });
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end();
      return;
    }

    if (req.method === "HEAD" && url.pathname === postPath) {
      logRequest(req, url, { kind: "head-post" });
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === ssePath) {
      logRequest(req, url, { kind: "sse" });
      await handleSseRequest(res);
      return;
    }

    if (req.method === "POST" && url.pathname === postPath) {
      logRequest(req, url, { kind: "post" });
      await handlePostMessage(req, res, url);
      return;
    }

    // Basic landing + health endpoints.
    // Some clients (and proxies) probe the service root for reachability.
    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/healthz")) {
      logRequest(req, url, { kind: url.pathname === "/healthz" ? "healthz" : "root" });
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      const baseUrl =
        process.env.BASE_URL ??
        process.env.ASSETS_BASE_URL ??
        lastSeenPublicBaseUrl ??
        inferPublicBaseUrl(req);
      const body =
        url.pathname === "/healthz"
          ? "ok"
          : [
              "Pizzaz MCP server",
              "",
              `Public base URL: ${baseUrl ?? "(unknown)"}`,
              `SSE: ${baseUrl ?? ""}/mcp`,
              `HTTP JSON-RPC: ${baseUrl ?? ""}/mcp`,
              "",
            ].join("\n");
      res.writeHead(200);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(body);
      return;
    }

    // Serve built widget assets from the same origin as the MCP server.
    // This eliminates the need for a second tunnel for assets.
    if (req.method === "GET" || req.method === "HEAD") {
      const pathname = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
      if (pathname && isSafeAssetPath(pathname)) {
        const candidate = path.resolve(ASSETS_DIR, pathname);
        if (candidate.startsWith(ASSETS_DIR + path.sep) && fs.existsSync(candidate)) {
          try {
            const stat = fs.statSync(candidate);
            if (stat.isFile()) {
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Cache-Control", "public, max-age=60");
              res.setHeader("Content-Type", contentTypeForFile(candidate));
              res.setHeader("Content-Length", String(stat.size));
              res.writeHead(200);
              if (req.method === "HEAD") {
                res.end();
                return;
              }
              fs.createReadStream(candidate).pipe(res);
              return;
            }
          } catch {
            // fall through to 404
          }
        }
      }
    }

    res.writeHead(404).end("Not Found");
  }
);

httpServer.on("clientError", (err: Error, socket) => {
  console.error("HTTP client error", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, () => {
  console.log(`Pizzaz MCP server listening on http://localhost:${port}`);
  console.log(`  SSE stream: GET http://localhost:${port}${ssePath}`);
  console.log(
    `  Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`
  );
});
