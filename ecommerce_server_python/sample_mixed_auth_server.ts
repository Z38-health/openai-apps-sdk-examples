import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer(
  {
    name: "Mixed Auth",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.registerTool(
  "public_echo",
  {
    description: "Echoes the provided text. Works with or without auth.",
    inputSchema: { text: z.string() },
    _meta: {
      securitySchemes: [{ type: "noauth" }, { type: "oauth2", scopes: [] }],
    },
  },
  async ({ text }, extra) => {
    const user = extra.authInfo?.extra?.email ?? "<anonymous>";
    return {
      content: [{ type: "text", text: JSON.stringify({ user, echoed: text }) }],
    };
  }
);

server.registerTool(
  "increment_item",
  {
    description: "Ren edited thrice: increments an item (requires OAuth2).",
    inputSchema: {},
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: ["secret:read"] }],
    },
  },
  async (_args, extra) => {
    const user = extra.authInfo?.extra?.email;

    // Unauthenticated / missing token → auth challenge
    if (!user) {
      const wwwAuthenticate =
        'Bearer error="invalid_request" error_description="No access token was provided" resource_metadata="https://tinymcp.dev/api/mixed-auth-b778ed/mcp"';

      return {
        // MCP tool result
        content: [
          {
            type: "text",
            text: "Authentication required: no access token provided.",
          },
        ],
        _meta: {
          // One or more RFC 9278-style WWW-Authenticate values
          "mcp/www_authenticate": [wwwAuthenticate],
        },
        // Marks this as an error ToolResponse per the spec
        isError: true,
      };
    }

    // Authenticated success path
    return {
      content: [
        { type: "text", text: JSON.stringify({ item: "hunter2", user }) },
      ],
    };
  }
);
