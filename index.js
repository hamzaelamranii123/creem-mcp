const express = require("express");
const crypto = require("crypto");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const app = express();
const port = process.env.PORT || 3000;
const creemBaseUrl = (
  process.env.CREEM_API_BASE_URL || "https://api.creem.io/v1"
).replace(/\/$/, "");
const streamableSessions = new Map();
const sseSessions = new Map();

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function creemRequest(path, options = {}) {
  const apiKey = process.env.CREEM_API_KEY;
  if (!apiKey) throw new Error("CREEM_API_KEY is not configured on the server.");

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
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`Creem API ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
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
        description: "Create a product in Creem. Pass the exact product payload in body.",
        inputSchema: { type: "object", properties: { body: { type: "object", additionalProperties: true } }, required: ["body"] },
      },
      {
        name: "list_products",
        description: "List or search products in Creem.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, page: { type: "string" }, limit: { type: "string" } } },
      },
      {
        name: "get_product",
        description: "Retrieve a Creem product by ID.",
        inputSchema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
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
            body: { type: "object", additionalProperties: true },
          },
          required: ["product_id"],
        },
      },
      {
        name: "get_checkout",
        description: "Retrieve a Creem checkout and payment status.",
        inputSchema: { type: "object", properties: { checkout_id: { type: "string" } }, required: ["checkout_id"] },
      },
      {
        name: "get_subscription",
        description: "Retrieve a Creem subscription and its status.",
        inputSchema: { type: "object", properties: { subscription_id: { type: "string" } }, required: ["subscription_id"] },
      },
      {
        name: "get_transaction",
        description: "Retrieve a Creem transaction by transaction ID.",
        inputSchema: {
          type: "object",
          properties: { transaction_id: { type: "string" } },
          required: ["transaction_id"],
        },
      },
      {
        name: "list_transactions",
        description: "Search Creem transactions, optionally filtered by customer ID.",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            page_number: { type: "integer", minimum: 1 },
            page_size: { type: "integer", minimum: 1 },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "create_product":
          return jsonResult(await creemRequest("/products", { method: "POST", body: JSON.stringify(args.body) }));
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
          const body = { ...(args.body || {}), product_id: args.product_id };
          if (args.success_url) body.success_url = args.success_url;
          if (args.customer_email) body.customer = { email: args.customer_email };
          return jsonResult(await creemRequest("/checkouts", { method: "POST", body: JSON.stringify(body) }));
        }
        case "get_checkout":
          return jsonResult(await creemRequest(`/checkouts/${encodeURIComponent(args.checkout_id)}`));
        case "get_subscription":
          return jsonResult(await creemRequest(`/subscriptions/${encodeURIComponent(args.subscription_id)}`));
        case "get_transaction": {
          const params = new URLSearchParams({ transaction_id: args.transaction_id });
          return jsonResult(await creemRequest(`/transactions?${params}`));
        }
        case "list_transactions": {
          const params = new URLSearchParams();
          if (args.customer_id) params.set("customer_id", args.customer_id);
          if (args.page_number !== undefined) params.set("page_number", String(args.page_number));
          if (args.page_size !== undefined) params.set("page_size", String(args.page_size));
          const suffix = params.toString() ? `?${params}` : "";
          return jsonResult(await creemRequest(`/transactions/search${suffix}`));
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

function cors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

app.use(cors);
app.use(express.json());

app.get("/", (req, res) => res.json({ ok: true, service: "creem-mcp-server" }));
app.get("/health", (req, res) => res.json({ ok: true, service: "creem-mcp-server" }));

// Modern MCP transport used by Claude and other remote MCP clients.
async function handleStreamableHttp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  let entry = sessionId ? streamableSessions.get(sessionId) : undefined;

  if (!entry && req.method !== "POST") {
    return res.status(400).json({ error: "Missing or invalid MCP session" });
  }

  if (!entry) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        streamableSessions.set(newSessionId, { transport, server });
      },
    });
    entry = { transport, server };
    await server.connect(transport);
  }

  try {
    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP HTTP error:", error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
}

app.all("/mcp", handleStreamableHttp);

// Legacy SSE compatibility for clients that still use the older transport.
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();
  sseSessions.set(transport.sessionId, { transport, server });
  res.on("close", () => sseSessions.delete(transport.sessionId));
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sessionId && sseSessions.get(sessionId);
  if (!entry) return res.status(400).send("Invalid or missing sessionId");
  await entry.transport.handlePostMessage(req, res);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Creem MCP server listening on port ${port}`);
});
