const express = require("express");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");

const app = express();
const port = process.env.PORT || 3000;

// إنشاء خادم MCP تعريفي فارغ ومستقر لـ Claude
const server = new Server({
  name: "creem-mcp-server",
  version: "1.0.0"
}, {
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  }
});

let transport;

app.get("/mcp", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handleMessage(req, res);
  } else {
    res.status(400).send("No active transport");
  }
});

app.listen(port, () => {
  console.log(`MCP SSE Server running on port ${port}`);
});
