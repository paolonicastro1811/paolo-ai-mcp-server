import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = "https://api.perplexity.ai";
const API_KEY = process.env.PERPLEXITY_API_KEY || "";

export function registerPerplexityTools(server: McpServer) {

  // Ricerca con Perplexity
  server.registerTool(
    "perplexity_search",
    {
      title: "Perplexity - Ricerca AI",
      description: "Effettua una ricerca con Perplexity AI ottenendo risposte aggiornate con fonti citate. Ideale per notizie recenti, ricerche web, fatti aggiornati.",
      inputSchema: {
        query: z.string().min(1).max(1000).describe("Domanda o query di ricerca"),
        model: z.enum([
          "llama-3.1-sonar-small-128k-online",
          "llama-3.1-sonar-large-128k-online",
          "llama-3.1-sonar-huge-128k-online",
        ]).default("llama-3.1-sonar-large-128k-online").describe("Modello Perplexity da usare"),
        search_recency_filter: z.enum(["month", "week", "day", "hour"]).optional().describe("Filtra risultati per data: month, week, day, hour"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, model, search_recency_filter }) => {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: "Sei un assistente preciso. Rispondi in italiano con fonti citate." },
          { role: "user", content: query },
        ],
        return_citations: true,
      };
      if (search_recency_filter) body.search_recency_filter = search_recency_filter;

      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Perplexity error: ${res.status} ${await res.text()}`);
      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        citations?: string[];
      };
      const content = data.choices[0]?.message?.content || "Nessuna risposta";
      const citations = data.citations?.map((c, i) => `[${i + 1}] ${c}`).join("\n") || "";
      const text = citations ? `${content}\n\n📚 Fonti:\n${citations}` : content;
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
