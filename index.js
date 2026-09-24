const express = require("express");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const app = express();
const port = process.env.PORT || 3000;
const creemBaseUrl = (
  process.env.CREEM_API_BASE_URL || "https://api.creem.io/v1"
).replace(/\/$/, "");
const transports = new Map();

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

async function creemRequest(path, options = {}) {
  const apiKey = process.env.CREEM_API_KEY;
  if (!apiKey) {
    throw new Error("CREEM_API_KEY is not configured on the server.");
  }

  const response = await fetch(`${creemBaseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!response.ok) {
    const details = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Creem API ${response.status}: ${details}`);
  }
  return data;
}

function createMcpServer() {
  const server = new Server(
    { name: "creem-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_product",
        description:
          "Create a product in Creem. Pass the exact product fields expected by your Creem account in the body object.",
        inputSchema: {
          type: "object",
          properties: {
            body: {
              type: "object",
              description:
                "Creem product payload, for example name, description, price, currency, and billing details.",
              additionalProperties: true,
            },
          },
          required: ["body"],
        },
      },
      {
        name: "list_products",
        description: "List or search products available in the Creem account.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            page: { type: "string" },
            limit: { type: "string" },
          },
        },
      },
      {
        name: "get_product",
        description: "Retrieve one Creem product by its product ID.",
        inputSchema: {
          type: "object",
          properties: { product_id: { type: "string" } },
          required: ["product_id"],
        },
      },
      {
        name: "create_checkout",
        description: "Create a Creem checkout link for a product.",
        inputSchema: {
          type: "object",
          properties: {
            product_id: { type: "string" },
            success_url: { type: "string" },
            customer_email: { type: "string" },
            body: {
              type: "object",
              description: "Optional exact Creem checkout payload fields.",
              additionalProperties: true,
            },
          },
          required: ["product_id"],
        },
      },
      {
        name: "get_checkout",
        description: "Retrieve a Creem checkout and its payment status.",
        inputSchema: {
          type: "object",
          properties: { checkout_id: { type: "string" } },
          required: ["checkout_id"],
        },
      },
      {
        name: "get_subscription",
        description: "Retrieve a Creem subscription and its current status.",
        inputSchema: {
          type: "object",
          properties: { subscription_id: { type: "string" } },
          required: ["subscription_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case "create_product":
          return jsonResult(
            await creemRequest("/products", {
              method: "POST",
              body: JSON.stringify(args.body),
            })
          );

        case "list_products": {
          const params = new URLSearchParams();
          if (args.query) params.set("query", args.query);
          if (args.page) params.set("page", args.page);
          if (args.limit) params.set("limit", args.limit);
          const suffix = params.toString() ? `?${params}` : "";
          return jsonResult(await creemRequest(`/products/search${suffix}`));
        }

        case "get_product":
          return jsonResult(await creemRequest(`/products/${encodeURIComponent(args.product_id)}`));

        case "create_checkout": {
          const body = {
            ...(args.body || {}),
            product_id: args.product_id,
          };
          if (args.success_url) body.success_url = args.success_url;
          if (args.customer_email) body.customer = { email: args.customer_email };
          return jsonResult(
            await creemRequest("/checkouts", {
              method: "POST",
              body: JSON.stringify(body),
            })
          );
        }

        case "get_checkout":
          return jsonResult(await creemRequest(`/checkouts/${encodeURIComponent(args.checkout_id)}`));

        case "get_subscription":
          return jsonResult(
            await creemRequest(`/subscriptions/${encodeURIComponent(args.subscription_id)}`)
          );

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "creem-mcp-server" });
});

app.get("/mcp", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    const server = createMcpServer();
    transports.set(transport.sessionId, { transport, server });
    res.on("close", () => transports.delete(transport.sessionId));
    await server.connect(transport);
  } catch (error) {
    console.error("MCP connection error:", error);
    if (!res.headersSent) res.status(500).send("MCP connection failed");
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sessionId && transports.get(sessionId);
  if (!entry) {
    return res.status(400).send("Invalid or missing sessionId");
  }

  try {
    await entry.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("MCP message error:", error);
    if (!res.headersSent) res.status(500).send("MCP message failed");
  }
});

app.listen(port, () => {
  console.log(`Creem MCP server listening on port ${port}`);
});
