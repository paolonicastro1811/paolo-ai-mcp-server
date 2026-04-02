import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = "https://api.elevenlabs.io/v1";
const API_KEY = process.env.ELEVENLABS_API_KEY || "";

export function registerElevenLabsTools(server: McpServer) {

  // Lista voci disponibili
  server.registerTool(
    "elevenlabs_list_voices",
    {
      title: "ElevenLabs - Lista Voci",
      description: "Elenca tutte le voci disponibili su ElevenLabs, con ID, nome e categoria.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const res = await fetch(`${BASE_URL}/voices`, {
        headers: { "xi-api-key": API_KEY },
      });
      if (!res.ok) throw new Error(`ElevenLabs error: ${res.status} ${await res.text()}`);
      const data = await res.json() as { voices: Array<{ voice_id: string; name: string; category: string }> };
      const voices = data.voices.map((v) => `${v.name} (ID: ${v.voice_id}, categoria: ${v.category})`).join("\n");
      return { content: [{ type: "text" as const, text: voices }] };
    }
  );

  // Text to speech
  server.registerTool(
    "elevenlabs_text_to_speech",
    {
      title: "ElevenLabs - Text to Speech",
      description: "Converte testo in audio usando una voce ElevenLabs. Restituisce l'URL del file audio generato (base64 se diretto). Specifica voice_id (usa elevenlabs_list_voices per ottenerlo).",
      inputSchema: {
        text: z.string().min(1).max(5000).describe("Testo da convertire in audio"),
        voice_id: z.string().describe("ID della voce ElevenLabs da usare"),
        model_id: z.string().default("eleven_multilingual_v2").describe("Modello da usare (default: eleven_multilingual_v2)"),
        stability: z.number().min(0).max(1).default(0.5).describe("Stabilità voce (0-1)"),
        similarity_boost: z.number().min(0).max(1).default(0.75).describe("Similarità alla voce originale (0-1)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ text, voice_id, model_id, stability, similarity_boost }) => {
      const res = await fetch(`${BASE_URL}/text-to-speech/${voice_id}`, {
        method: "POST",
        headers: {
          "xi-api-key": API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id,
          voice_settings: { stability, similarity_boost },
        }),
      });
      if (!res.ok) throw new Error(`ElevenLabs TTS error: ${res.status} ${await res.text()}`);
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return {
        content: [{
          type: "text" as const,
          text: `Audio generato con successo!\nVoce: ${voice_id}\nModello: ${model_id}\nTesto: "${text.substring(0, 50)}..."\n\nDati audio (base64, formato mp3):\ndata:audio/mpeg;base64,${base64.substring(0, 100)}... [troncato per visualizzazione]`,
        }],
      };
    }
  );

  // Clona voce da testo
  server.registerTool(
    "elevenlabs_list_models",
    {
      title: "ElevenLabs - Lista Modelli",
      description: "Elenca i modelli disponibili su ElevenLabs (multilingue, turbo, ecc.).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { "xi-api-key": API_KEY },
      });
      if (!res.ok) throw new Error(`ElevenLabs error: ${res.status} ${await res.text()}`);
      const data = await res.json() as Array<{ model_id: string; name: string; description: string }>;
      const models = data.map((m) => `${m.name} (ID: ${m.model_id}): ${m.description}`).join("\n\n");
      return { content: [{ type: "text" as const, text: models }] };
    }
  );
}
