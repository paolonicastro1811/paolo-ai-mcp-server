import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = "https://api.heygen.com/v2";
const V1_URL = "https://api.heygen.com/v1";
const API_KEY = process.env.HEYGEN_API_KEY || "";

export function registerHeyGenTools(server: McpServer) {

  // Lista avatar disponibili
  server.registerTool(
    "heygen_list_avatars",
    {
      title: "HeyGen - Lista Avatar",
      description: "Elenca gli avatar disponibili su HeyGen per la generazione di video.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const res = await fetch(`${V1_URL}/avatar.list`, {
        headers: { "X-Api-Key": API_KEY },
      });
      if (!res.ok) throw new Error(`HeyGen error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { data: { avatars: Array<{ avatar_id: string; avatar_name: string }> } };
      const avatars = data.data.avatars.slice(0, 20).map((a) => `${a.avatar_name} (ID: ${a.avatar_id})`).join("\n");
      return { content: [{ type: "text" as const, text: `Avatar disponibili (primi 20):\n\n${avatars}` }] };
    }
  );

  // Lista voci HeyGen
  server.registerTool(
    "heygen_list_voices",
    {
      title: "HeyGen - Lista Voci",
      description: "Elenca le voci disponibili su HeyGen per i video avatar.",
      inputSchema: {
        language: z.string().optional().describe("Filtra per lingua (es: 'it', 'en', 'pt')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language }) => {
      const res = await fetch(`${V1_URL}/voice.list`, {
        headers: { "X-Api-Key": API_KEY },
      });
      if (!res.ok) throw new Error(`HeyGen error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { data: { voices: Array<{ voice_id: string; language: string; name: string }> } };
      let voices = data.data.voices;
      if (language) voices = voices.filter((v) => v.language.toLowerCase().startsWith(language.toLowerCase()));
      const text = voices.slice(0, 20).map((v) => `${v.name} (ID: ${v.voice_id}, lingua: ${v.language})`).join("\n");
      return { content: [{ type: "text" as const, text: `Voci disponibili:\n\n${text}` }] };
    }
  );

  // Genera video con avatar
  server.registerTool(
    "heygen_generate_video",
    {
      title: "HeyGen - Genera Video Avatar",
      description: "Genera un video con un avatar AI che parla un testo. Usa heygen_list_avatars e heygen_list_voices per ottenere gli ID.",
      inputSchema: {
        script_text: z.string().min(1).max(2000).describe("Testo che l'avatar deve pronunciare"),
        avatar_id: z.string().describe("ID dell'avatar (da heygen_list_avatars)"),
        voice_id: z.string().describe("ID della voce (da heygen_list_voices)"),
        background_color: z.string().default("#ffffff").describe("Colore sfondo hex (default: bianco)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ script_text, avatar_id, voice_id, background_color }) => {
      const res = await fetch(`${BASE_URL}/video/generate`, {
        method: "POST",
        headers: {
          "X-Api-Key": API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          video_inputs: [{
            character: { type: "avatar", avatar_id, avatar_style: "normal" },
            voice: { type: "text", input_text: script_text, voice_id },
            background: { type: "color", value: background_color },
          }],
          dimension: { width: 1280, height: 720 },
        }),
      });
      if (!res.ok) throw new Error(`HeyGen error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { data: { video_id: string } };
      return {
        content: [{
          type: "text" as const,
          text: `🎬 Video in generazione!\nVideo ID: ${data.data.video_id}\nAvatar: ${avatar_id}\nVoce: ${voice_id}\n\nUsa heygen_check_status con il Video ID per monitorare il progresso.`,
        }],
      };
    }
  );

  // Controlla stato video
  server.registerTool(
    "heygen_check_status",
    {
      title: "HeyGen - Controlla Stato Video",
      description: "Controlla lo stato di un video HeyGen in generazione. Quando pronto, fornisce l'URL del video.",
      inputSchema: {
        video_id: z.string().describe("ID del video restituito da heygen_generate_video"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ video_id }) => {
      const res = await fetch(`${V1_URL}/video_status.get?video_id=${video_id}`, {
        headers: { "X-Api-Key": API_KEY },
      });
      if (!res.ok) throw new Error(`HeyGen error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { data: { status: string; video_url?: string; duration?: number } };
      const d = data.data;
      let text = `Video ID: ${video_id}\nStato: ${d.status}`;
      if (d.duration) text += `\nDurata: ${d.duration}s`;
      if (d.video_url) text += `\n\n✅ Video pronto!\nURL: ${d.video_url}`;
      else text += "\n\n⏳ Ancora in elaborazione. Riprova tra qualche secondo.";
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
