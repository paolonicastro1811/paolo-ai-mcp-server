import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = "https://api.openai.com/v1";
const API_KEY = process.env.OPENAI_API_KEY || "";

export function registerOpenAITools(server: McpServer) {

  // Chat con GPT
  server.registerTool(
    "openai_chat",
    {
      title: "OpenAI - Chat GPT",
      description: "Invia un messaggio a GPT-4o o altri modelli OpenAI. Utile per avere una seconda opinione AI, confrontare risposte, o usare GPT per task specifici.",
      inputSchema: {
        message: z.string().min(1).max(10000).describe("Il messaggio da inviare a GPT"),
        model: z.enum(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]).default("gpt-4o").describe("Modello OpenAI da usare"),
        system_prompt: z.string().max(2000).optional().describe("Istruzione di sistema per personalizzare il comportamento"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message, model, system_prompt }) => {
      const messages: Array<{ role: string; content: string }> = [];
      if (system_prompt) messages.push({ role: "system", content: system_prompt });
      messages.push({ role: "user", content: message });

      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, max_tokens: 2000 }),
      });
      if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        usage: { total_tokens: number };
      };
      const reply = data.choices[0]?.message?.content || "Nessuna risposta";
      return {
        content: [{
          type: "text" as const,
          text: `🤖 ${model}\n\n${reply}\n\n[Token usati: ${data.usage.total_tokens}]`,
        }],
      };
    }
  );

  // Genera immagine con DALL-E
  server.registerTool(
    "openai_generate_image",
    {
      title: "OpenAI - Genera Immagine DALL-E",
      description: "Genera un'immagine con DALL-E 3 da un prompt testuale. Restituisce l'URL dell'immagine generata.",
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("Descrizione dettagliata dell'immagine da generare"),
        size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).default("1024x1024").describe("Dimensione immagine"),
        quality: z.enum(["standard", "hd"]).default("standard").describe("Qualità: standard o hd"),
        style: z.enum(["vivid", "natural"]).default("vivid").describe("Stile: vivid (drammatico) o natural (realistico)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ prompt, size, quality, style }) => {
      const res = await fetch(`${BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt,
          n: 1,
          size,
          quality,
          style,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI DALL-E error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { data: Array<{ url: string; revised_prompt?: string }> };
      const img = data.data[0];
      let text = `🎨 Immagine generata con DALL-E 3!\nURL: ${img.url}\nDimensione: ${size} | Qualità: ${quality} | Stile: ${style}`;
      if (img.revised_prompt) text += `\n\nPrompt revisionato da DALL-E:\n"${img.revised_prompt}"`;
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // Lista modelli OpenAI
  server.registerTool(
    "openai_list_models",
    {
      title: "OpenAI - Lista Modelli",
      description: "Elenca i modelli OpenAI disponibili con il tuo account.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { "Authorization": `Bearer ${API_KEY}` },
      });
      if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { data: Array<{ id: string; created: number }> };
      const models = data.data
        .filter((m) => m.id.startsWith("gpt") || m.id.startsWith("dall") || m.id.startsWith("tts") || m.id.startsWith("whisper"))
        .sort((a, b) => b.created - a.created)
        .slice(0, 30)
        .map((m) => m.id)
        .join("\n");
      return { content: [{ type: "text" as const, text: `Modelli principali:\n\n${models}` }] };
    }
  );
}
