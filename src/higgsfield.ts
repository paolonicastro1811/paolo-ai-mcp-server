import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = "https://api.higgsfield.ai";
const API_KEY = process.env.HIGGSFIELD_API_KEY || "";

export function registerHiggsieldTools(server: McpServer) {

  // Genera video da testo
  server.registerTool(
    "higgsfield_generate_video",
    {
      title: "Higgsfield - Genera Video",
      description: "Genera un video AI da un prompt testuale usando Higgsfield. Restituisce l'ID del job per monitorare lo stato.",
      inputSchema: {
        prompt: z.string().min(1).max(1000).describe("Descrizione del video da generare"),
        duration: z.number().min(1).max(30).default(5).describe("Durata del video in secondi"),
        aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9").describe("Rapporto d'aspetto del video"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ prompt, duration, aspect_ratio }) => {
      const res = await fetch(`${BASE_URL}/v1/video/generate`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, duration, aspect_ratio }),
      });
      if (!res.ok) throw new Error(`Higgsfield error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { job_id: string; status: string };
      return {
        content: [{
          type: "text" as const,
          text: `Video in generazione!\nJob ID: ${data.job_id}\nStato: ${data.status}\nPrompt: "${prompt}"\nDurata: ${duration}s | Formato: ${aspect_ratio}\n\nUsa higgsfield_check_status con il Job ID per monitorare il progresso.`,
        }],
      };
    }
  );

  // Controlla stato job
  server.registerTool(
    "higgsfield_check_status",
    {
      title: "Higgsfield - Controlla Stato",
      description: "Controlla lo stato di un job di generazione video Higgsfield. Quando completato, fornisce l'URL del video.",
      inputSchema: {
        job_id: z.string().describe("ID del job restituito da higgsfield_generate_video"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => {
      const res = await fetch(`${BASE_URL}/v1/video/status/${job_id}`, {
        headers: { "Authorization": `Bearer ${API_KEY}` },
      });
      if (!res.ok) throw new Error(`Higgsfield error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { status: string; video_url?: string; progress?: number };
      let text = `Job ID: ${job_id}\nStato: ${data.status}`;
      if (data.progress !== undefined) text += `\nProgresso: ${data.progress}%`;
      if (data.video_url) text += `\n\n✅ Video pronto!\nURL: ${data.video_url}`;
      else text += "\n\n⏳ Video ancora in elaborazione. Riprova tra qualche secondo.";
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
