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

function bodyRequest(method, path, body) {
  return creemRequest(path, { method, body: JSON.stringify(body || {}) });
}

function idSchema(name, description) {
  return {
    type: "object",
    properties: { [name]: { type: "string", description } },
    required: [name],
  };
}

function createMcpServer() {
  const server = new Server(
    { name: "creem-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "create_product", description: "Create a product in Creem. Pass the exact product payload in body.", inputSchema: { type: "object", properties: { body: { type: "object", additionalProperties: true } }, required: ["body"] } },
      { name: "list_products", description: "List or search products in Creem.", inputSchema: { type: "object", properties: { query: { type: "string" }, page: { type: "string" }, limit: { type: "string" } } } },
      { name: "get_product", description: "Retrieve a Creem product by ID.", inputSchema: idSchema("product_id", "Creem product ID") },
      { name: "create_checkout", description: "Create a Creem checkout link for a product.", inputSchema: { type: "object", properties: { product_id: { type: "string" }, success_url: { type: "string" }, customer_email: { type: "string" }, body: { type: "object", additionalProperties: true } }, required: ["product_id"] } },
      { name: "get_checkout", description: "Retrieve a Creem checkout and payment status.", inputSchema: idSchema("checkout_id", "Creem checkout ID") },
      { name: "get_subscription", description: "Retrieve a Creem subscription and its status.", inputSchema: idSchema("subscription_id", "Creem subscription ID") },
      { name: "cancel_subscription", description: "Cancel a Creem subscription. This is a state-changing operation; confirm before using.", inputSchema: { type: "object", properties: { subscription_id: { type: "string" }, body: { type: "object", additionalProperties: true } }, required: ["subscription_id"] } },
      { name: "update_subscription", description: "Update a Creem subscription using the exact supported fields in body.", inputSchema: { type: "object", properties: { subscription_id: { type: "string" }, body: { type: "object", additionalProperties: true } }, required: ["subscription_id", "body"] } },
      { name: "upgrade_subscription", description: "Upgrade a Creem subscription using the exact supported fields in body. Confirm before using.", inputSchema: { type: "object", properties: { subscription_id: { type: "string" }, body: { type: "object", additionalProperties: true } }, required: ["subscription_id", "body"] } },
      { name: "get_transaction", description: "Retrieve a Creem transaction by transaction ID.", inputSchema: idSchema("transaction_id", "Creem transaction ID") },
      { name: "list_transactions", description: "Search Creem transactions, optionally filtered by customer ID.", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, page_number: { type: "integer", minimum: 1 }, page_size: { type: "integer", minimum: 1 } } } },
      { name: "get_customer", description: "Retrieve a Creem customer by customer ID or email.", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, email: { type: "string" } } } },
      { name: "create_customer_billing_portal", description: "Create a billing portal link for a Creem customer.", inputSchema: { type: "object", properties: { body: { type: "object", description: "Exact Creem billing portal payload, such as customer_id.", additionalProperties: true } }, required: ["body"] } },
      { name: "get_license", description: "Retrieve a Creem license by license key or ID.", inputSchema: { type: "object", properties: { license_key: { type: "string" }, license_id: { type: "string" } } } },
      { name: "activate_license", description: "Activate a Creem license. Confirm before using.", inputSchema: { type: "object", properties: { body: { type: "object", additionalProperties: true } }, required: ["body"] } },
      { name: "deactivate_license", description: "Deactivate a Creem license. Confirm before using.", inputSchema: { type: "object", properties: { body: { type: "object", additionalProperties: true } }, required: ["body"] } },
      { name: "validate_license", description: "Validate a Creem license.", inputSchema: { type: "object", properties: { body: { type: "object", additionalProperties: true } }, required: ["body"] } },
      { name: "get_discount", description: "Retrieve a Creem discount by ID.", inputSchema: idSchema("discount_id", "Creem discount ID") },
      { name: "create_discount", description: "Create a Creem discount using the exact supported fields in body.", inputSchema: { type: "object", properties: { body: { type: "object", additionalProperties: true } }, required: ["body"] } },
      { name: "delete_discount", description: "Delete a Creem discount. Confirm before using.", inputSchema: idSchema("discount_id", "Creem discount ID") },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "create_product": return jsonResult(await bodyRequest("POST", "/products", args.body));
        case "list_products": {
          const p = new URLSearchParams();
          if (args.query) p.set("query", args.query);
          if (args.page) p.set("page", args.page);
          if (args.limit) p.set("limit", args.limit);
          return jsonResult(await creemRequest(`/products/search${p.toString() ? `?${p}` : ""}`));
        }
        case "get_product": return jsonResult(await creemRequest(`/products/${encodeURIComponent(args.product_id)}`));
        case "create_checkout": {
          const body = { ...(args.body || {}), product_id: args.product_id };
          if (args.success_url) body.success_url = args.success_url;
          if (args.customer_email) body.customer = { email: args.customer_email };
          return jsonResult(await bodyRequest("POST", "/checkouts", body));
        }
        case "get_checkout": return jsonResult(await creemRequest(`/checkouts/${encodeURIComponent(args.checkout_id)}`));
        case "get_subscription": return jsonResult(await creemRequest(`/subscriptions/${encodeURIComponent(args.subscription_id)}`));
        case "cancel_subscription": return jsonResult(await bodyRequest("POST", `/subscriptions/${encodeURIComponent(args.subscription_id)}/cancel`, args.body));
        case "update_subscription": return jsonResult(await bodyRequest("POST", `/subscriptions/${encodeURIComponent(args.subscription_id)}`, args.body));
        case "upgrade_subscription": return jsonResult(await bodyRequest("POST", `/subscriptions/${encodeURIComponent(args.subscription_id)}/upgrade`, args.body));
        case "get_transaction": {
          const p = new URLSearchParams({ transaction_id: args.transaction_id });
          return jsonResult(await creemRequest(`/transactions?${p}`));
        }
        case "list_transactions": {
          const p = new URLSearchParams();
          if (args.customer_id) p.set("customer_id", args.customer_id);
          if (args.page_number !== undefined) p.set("page_number", String(args.page_number));
          if (args.page_size !== undefined) p.set("page_size", String(args.page_size));
          return jsonResult(await creemRequest(`/transactions/search${p.toString() ? `?${p}` : ""}`));
        }
        case "get_customer": {
          const p = new URLSearchParams();
          if (args.customer_id) p.set("customer_id", args.customer_id);
          if (args.email) p.set("email", args.email);
          return jsonResult(await creemRequest(`/customers${p.toString() ? `?${p}` : ""}`));
        }
        case "create_customer_billing_portal": return jsonResult(await bodyRequest("POST", "/customers/billing", args.body));
        case "get_license": {
          const p = new URLSearchParams();
          if (args.license_key) p.set("license_key", args.license_key);
          if (args.license_id) p.set("license_id", args.license_id);
          return jsonResult(await creemRequest(`/licenses${p.toString() ? `?${p}` : ""}`));
        }
        case "activate_license": return jsonResult(await bodyRequest("POST", "/licenses/activate", args.body));
        case "deactivate_license": return jsonResult(await bodyRequest("POST", "/licenses/deactivate", args.body));
        case "validate_license": return jsonResult(await bodyRequest("POST", "/licenses/validate", args.body));
        case "get_discount": return jsonResult(await creemRequest(`/discounts/${encodeURIComponent(args.discount_id)}`));
        case "create_discount": return jsonResult(await bodyRequest("POST", "/discounts", args.body));
        case "delete_discount": return jsonResult(await creemRequest(`/discounts/${encodeURIComponent(args.discount_id)}`, { method: "DELETE" }));
        default: return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) { return errorResult(error); }
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

async function handleStreamableHttp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  let entry = sessionId ? streamableSessions.get(sessionId) : undefined;
  if (!entry && req.method !== "POST") return res.status(400).json({ error: "Missing or invalid MCP session" });
  if (!entry) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => streamableSessions.set(newSessionId, { transport, server }),
    });
    entry = { transport, server };
    await server.connect(transport);
  }
  try { await entry.transport.handleRequest(req, res, req.body); }
  catch (error) { console.error("MCP HTTP error:", error); if (!res.headersSent) res.status(500).json({ error: "MCP request failed" }); }
}

app.all("/mcp", handleStreamableHttp);
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();
  sseSessions.set(transport.sessionId, { transport, server });
  res.on("close", () => sseSessions.delete(transport.sessionId));
  await server.connect(transport);
});
app.post("/messages", async (req, res) => {
  const entry = req.query.sessionId && sseSessions.get(req.query.sessionId);
  if (!entry) return res.status(400).send("Invalid or missing sessionId");
  await entry.transport.handlePostMessage(req, res);
});
app.listen(port, "0.0.0.0", () => console.log(`Creem MCP server listening on port ${port}`));
