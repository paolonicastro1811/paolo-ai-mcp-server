import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerElevenLabsTools } from "../elevenlabs.js";
import { registerHiggsieldTools } from "../higgsfield.js";
import { registerPerplexityTools } from "../perplexity.js";
import { registerSegmindTools } from "../segmind.js";
import { registerSunoTools } from "../suno.js";
import { registerHeyGenTools } from "../heygen.js";
import { registerOpenAITools } from "../openai.js";

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "Paolo AI MCP Server", version: "1.0.0" });
});

app.post("/mcp", async (req, res) => {
  const server = new McpServer({
    name: "paolo-ai-mcp-server",
    version: "1.0.0",
  });

  registerElevenLabsTools(server);
  registerHiggsieldTools(server);
  registerPerplexityTools(server);
  registerSegmindTools(server);
  registerSunoTools(server);
  registerHeyGenTools(server);
  registerOpenAITools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Paolo AI MCP Server in ascolto su porta ${PORT}`);
});

export default app;
