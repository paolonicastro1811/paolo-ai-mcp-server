import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_KEY = process.env.SUNO_API_KEY || "";
// Suno usa API di terze parti (acedata) come intermediario
const BASE_URL = "https://api.acedata.cloud/suno";

export function registerSunoTools(server: McpServer) {

  // Genera musica
  server.registerTool(
    "suno_generate_music",
    {
      title: "Suno - Genera Musica",
      description: "Genera una canzone/musica AI con Suno. Puoi specificare un prompt descrittivo e uno stile musicale. Restituisce l'ID del task per monitorare il risultato.",
      inputSchema: {
        prompt: z.string().min(1).max(500).describe("Descrizione della musica da generare (tema, umore, strumenti)"),
        style: z.string().max(200).optional().describe("Stile musicale (es: 'pop italiano', 'jazz', 'rock', 'classica')"),
        title: z.string().max(100).optional().describe("Titolo della canzone"),
        make_instrumental: z.boolean().default(false).describe("Se true, genera solo musica strumentale senza voce"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ prompt, style, title, make_instrumental }) => {
      const body: Record<string, unknown> = {
        prompt,
        make_instrumental,
      };
      if (style) body.style = style;
      if (title) body.title = title;

      const res = await fetch(`${BASE_URL}/audios`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Suno error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { id: string; status: string };
      return {
        content: [{
          type: "text" as const,
          text: `🎵 Musica in generazione!\nTask ID: ${data.id}\nStato: ${data.status}\nPrompt: "${prompt}"\n${style ? `Stile: ${style}\n` : ""}${title ? `Titolo: ${title}\n` : ""}\nUsa suno_check_status con il Task ID per ottenere il risultato.`,
        }],
      };
    }
  );

  // Controlla stato
  server.registerTool(
    "suno_check_status",
    {
      title: "Suno - Controlla Stato",
      description: "Controlla lo stato di un task di generazione musica Suno. Quando completato, fornisce l'URL del file audio.",
      inputSchema: {
        task_id: z.string().describe("ID del task restituito da suno_generate_music"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const res = await fetch(`${BASE_URL}/audios/${task_id}`, {
        headers: { "Authorization": `Bearer ${API_KEY}` },
      });
      if (!res.ok) throw new Error(`Suno error: ${res.status} ${await res.text()}`);
      const data = await res.json() as {
        status: string;
        audio_url?: string;
        title?: string;
        duration?: number;
      };
      let text = `Task ID: ${task_id}\nStato: ${data.status}`;
      if (data.title) text += `\nTitolo: ${data.title}`;
      if (data.duration) text += `\nDurata: ${data.duration}s`;
      if (data.audio_url) text += `\n\n✅ Musica pronta!\nURL: ${data.audio_url}`;
      else text += "\n\n⏳ Ancora in elaborazione. Riprova tra qualche secondo.";
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
