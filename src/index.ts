import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerElevenLabsTools } from "./tools/elevenlabs.js";
import { registerHiggsieldTools } from "./tools/higgsfield.js";
import { registerPerplexityTools } from "./tools/perplexity.js";
import { registerSunoTools } from "./tools/suno.js";
import { registerHeyGenTools } from "./tools/heygen.js";
import { registerOpenAITools } from "./tools/openai.js";

const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "Paolo AI MCP Server", version: "1.0.0" });
});

// MCP endpoint (stateless, per Vercel)
app.post("/mcp", async (req, res) => {
  const server = new McpServer({
    name: "paolo-ai-mcp-server",
    version: "1.0.0",
  });

  // Registra tutti i tool
  registerElevenLabsTools(server);
  registerHiggsieldTools(server);
  registerPerplexityTools(server);
  registerSunoTools(server);
  registerHeyGenTools(server);
  registerOpenAITools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Necessario anche GET per MCP Inspector
app.get("/mcp", async (req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Paolo AI MCP Server in ascolto su porta ${PORT}`);
});

export default app;
