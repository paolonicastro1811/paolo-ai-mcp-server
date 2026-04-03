import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const KEYS = {
  elevenlabs: process.env.ELEVENLABS_API_KEY || "",
  higgsfield: process.env.HIGGSFIELD_API_KEY || "",
  perplexity: process.env.PERPLEXITY_API_KEY || "",
  suno: process.env.SUNO_API_KEY || "",
  heygen: process.env.HEYGEN_API_KEY || "",
  openai: process.env.OPENAI_API_KEY || "",
  segmind: process.env.SEGMIND_API_KEY || "",
};

app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "Paolo AI MCP Server", version: "1.0.0" });
});

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "paolo-ai-mcp-server", version: "1.0.0" });

  // ===== ELEVENLABS =====
  server.registerTool("elevenlabs_list_voices", {
    title: "ElevenLabs - Lista Voci",
    description: "Elenca tutte le voci disponibili su ElevenLabs.",
    inputSchema: {},
  }, async () => {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": KEYS.elevenlabs } });
    const d = await r.json();
    const text = d.voices.map(v => `${v.name} (ID: ${v.voice_id})`).join("\n");
    return { content: [{ type: "text", text }] };
  });

  server.registerTool("elevenlabs_text_to_speech", {
    title: "ElevenLabs - Text to Speech",
    description: "Converte testo in audio usando una voce ElevenLabs.",
    inputSchema: {
      text: z.string().describe("Testo da convertire"),
      voice_id: z.string().describe("ID della voce"),
    },
  }, async ({ text, voice_id }) => {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
      method: "POST",
      headers: { "xi-api-key": KEYS.elevenlabs, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!r.ok) throw new Error(`ElevenLabs error: ${await r.text()}`);
    return { content: [{ type: "text", text: `\u2705 Audio generato con voce ${voice_id} per il testo: "${text.substring(0, 50)}..."` }] };
  });

  // ===== PERPLEXITY =====
  server.registerTool("perplexity_search", {
    title: "Perplexity - Ricerca AI",
    description: "Ricerca con Perplexity AI con fonti citate. Ideale per notizie recenti e fatti aggiornati.",
    inputSchema: {
      query: z.string().describe("Domanda o query di ricerca"),
    },
  }, async ({ query }) => {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEYS.perplexity}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: query }],
        return_citations: true,
      }),
    });
    if (!r.ok) throw new Error(`Perplexity error: ${await r.text()}`);
    const d = await r.json();
    const text = d.choices[0]?.message?.content || "Nessuna risposta";
    return { content: [{ type: "text", text }] };
  });

  // ===== OPENAI =====
  server.registerTool("openai_chat", {
    title: "OpenAI - Chat GPT",
    description: "Invia un messaggio a GPT-4o.",
    inputSchema: {
      message: z.string().describe("Il messaggio da inviare a GPT"),
      model: z.string().default("gpt-4o").describe("Modello OpenAI"),
    },
  }, async ({ message, model }) => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEYS.openai}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: message }], max_tokens: 2000 }),
    });
    if (!r.ok) throw new Error(`OpenAI error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: d.choices[0]?.message?.content || "Nessuna risposta" }] };
  });

  server.registerTool("openai_generate_image", {
    title: "OpenAI - Genera Immagine DALL-E",
    description: "Genera un'immagine con DALL-E 3.",
    inputSchema: {
      prompt: z.string().describe("Descrizione dell'immagine"),
      size: z.string().default("1024x1024").describe("Dimensione: 1024x1024, 1792x1024, 1024x1792"),
    },
  }, async ({ prompt, size }) => {
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEYS.openai}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size }),
    });
    if (!r.ok) throw new Error(`DALL-E error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `\u1f3a8 Immagine generata!\nURL: ${d.data[0].url}` }] };
  });

  // ===== HEYGEN (aggiornato a V2) =====
  server.registerTool("heygen_list_avatars", {
    title: "HeyGen - Lista Avatar",
    description: "Elenca gli avatar disponibili su HeyGen.",
    inputSchema: {},
  }, async () => {
    // FIX V2: era /v1/avatar.list
    const r = await fetch("https://api.heygen.com/v2/avatars", { headers: { "X-Api-Key": KEYS.heygen } });
    if (!r.ok) throw new Error(`HeyGen error: ${await r.text()}`);
    const d = await r.json();
    const avatars = d.data?.avatars || [];
    const text = avatars.slice(0, 100).map(a => `${a.avatar_name} (ID: ${a.avatar_id})`).join("\n");
    return { content: [{ type: "text", text: text || "Nessun avatar trovato" }] };
  });

  server.registerTool("heygen_list_voices", {
    title: "HeyGen - Lista Voci",
    description: "Elenca le voci disponibili su HeyGen, filtrabile per lingua.",
    inputSchema: {
      language: z.string().optional().describe("Filtro lingua es: Portuguese, English, Spanish"),
    },
  }, async ({ language }) => {
    const r = await fetch("https://api.heygen.com/v2/voices", { headers: { "X-Api-Key": KEYS.heygen } });
    if (!r.ok) throw new Error(`HeyGen error: ${await r.text()}`);
    const d = await r.json();
    let voices = d.data?.voices || [];
    if (language) voices = voices.filter(v => v.language?.toLowerCase().includes(language.toLowerCase()));
    const text = voices.slice(0, 30).map(v => `${v.name} | ${v.language} | ${v.gender} | ID: ${v.voice_id}`).join("\n");
    return { content: [{ type: "text", text: text || "Nessuna voce trovata" }] };
  });

  server.registerTool("heygen_generate_video", {
    title: "HeyGen - Genera Video Avatar",
    description: "Genera un video con un avatar AI che parla un testo.",
    inputSchema: {
      script_text: z.string().describe("Testo che l'avatar deve pronunciare"),
      avatar_id: z.string().describe("ID dell'avatar"),
      voice_id: z.string().describe("ID della voce"),
      background_url: z.string().optional().describe("URL immagine di sfondo (opzionale, default colore bianco)"),
    },
  }, async ({ script_text, avatar_id, voice_id, background_url }) => {
    const r = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": KEYS.heygen, "Content-Type": "application/json" },
      body: JSON.stringify({
        video_inputs: [{ character: { type: "avatar", avatar_id, avatar_style: "normal" }, voice: { type: "text", input_text: script_text, voice_id }, background: background_url ? { type: "image", url: background_url } : { type: "color", value: "#ffffff" } }],
        dimension: { width: 1280, height: 720 },
      }),
    });
    if (!r.ok) throw new Error(`HeyGen error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `\u1f3ac Video in generazione!\nVideo ID: ${d.data.video_id}\nUsa heygen_check_status per monitorare.` }] };
  });

  server.registerTool("heygen_check_status", {
    title: "HeyGen - Controlla Stato Video",
    description: "Controlla lo stato di un video HeyGen.",
    inputSchema: { video_id: z.string().describe("ID del video") },
  }, async ({ video_id }) => {
    // FIX V2: era /v1/video_status.get?video_id=...
    const r = await fetch(`https://api.heygen.com/v2/videos/${video_id}`, { headers: { "X-Api-Key": KEYS.heygen } });
    if (!r.ok) throw new Error(`HeyGen error: ${await r.text()}`);
    const d = await r.json();
    const videoData = d.data || {};
    const text = videoData.video_url ? `\u2705 Pronto!\nURL: ${videoData.video_url}` : `\u23f3 Stato: ${videoData.status}`;
    return { content: [{ type: "text", text }] };
  });

  // ===== SUNO =====
  server.registerTool("suno_generate_music", {
    title: "Suno - Genera Musica",
    description: "Genera musica AI con Suno.",
    inputSchema: {
      prompt: z.string().describe("Descrizione della musica"),
      style: z.string().optional().describe("Stile musicale"),
    },
  }, async ({ prompt, style }) => {
    const body = { prompt, make_instrumental: false };
    if (style) body.style = style;
    const r = await fetch("https://api.acedata.cloud/suno/audios", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEYS.suno}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Suno error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `\u1f3b5 Musica in generazione!\nTask ID: ${d.id}\nUsa suno_check_status per il risultato.` }] };
  });

  server.registerTool("suno_check_status", {
    title: "Suno - Controlla Stato",
    description: "Controlla lo stato di un task Suno.",
    inputSchema: { task_id: z.string().describe("ID del task") },
  }, async ({ task_id }) => {
    const r = await fetch(`https://api.acedata.cloud/suno/audios/${task_id}`, { headers: { "Authorization": `Bearer ${KEYS.suno}` } });
    if (!r.ok) throw new Error(`Suno error: ${await r.text()}`);
    const d = await r.json();
    const text = d.audio_url ? `\u2705 Pronto!\nURL: ${d.audio_url}` : `\u23f3 Stato: ${d.status}`;
    return { content: [{ type: "text", text }] };
  });

  // ===== HIGGSFIELD =====
  server.registerTool("higgsfield_generate_video", {
    title: "Higgsfield - Genera Video",
    description: "Genera un video AI da un prompt testuale.",
    inputSchema: {
      prompt: z.string().describe("Descrizione del video"),
      duration: z.number().default(5).describe("Durata in secondi"),
    },
  }, async ({ prompt, duration }) => {
    const r = await fetch("https://api.higgsfield.ai/v1/video/generate", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEYS.higgsfield}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, duration }),
    });
    if (!r.ok) throw new Error(`Higgsfield error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `\u1f3ac Video in generazione!\nJob ID: ${d.job_id}\nUsa higgsfield_check_status per monitorare.` }] };
  });

  server.registerTool("higgsfield_check_status", {
    title: "Higgsfield - Controlla Stato",
    description: "Controlla lo stato di un job Higgsfield.",
    inputSchema: { job_id: z.string().describe("ID del job") },
  }, async ({ job_id }) => {
    const r = await fetch(`https://api.higgsfield.ai/v1/video/status/${job_id}`, { headers: { "Authorization": `Bearer ${KEYS.higgsfield}` } });
    if (!r.ok) throw new Error(`Higgsfield error: ${await r.text()}`);
    const d = await r.json();
    const text = d.video_url ? `\u2705 Pronto!\nURL: ${d.video_url}` : `\u23f3 Stato: ${d.status}`;
    return { content: [{ type: "text", text }] };
  });

  // ===== SEGMIND =====
  server.registerTool("segmind_video_audio_merge", {
    title: "Segmind - Video Audio Merge",
    description: "Unisce un file video con un file audio (voiceover o musica).",
    inputSchema: {
      input_video: z.string().describe("URL del video"),
      input_audio: z.string().describe("URL dell'audio"),
      override_audio: z.boolean().default(true).describe("Sostituisci audio originale"),
      merge_intensity: z.number().default(0.8).describe("Intensit\u00e0 mix (0-1)"),
    },
  }, async ({ input_video, input_audio, override_audio, merge_intensity }) => {
    const r = await fetch("https://api.segmind.com/v1/video-audio-merge", {
      method: "POST",
      headers: { "x-api-key": KEYS.segmind, "Content-Type": "application/json" },
      body: JSON.stringify({ input_video, input_audio, video_start: 0, video_end: -1, audio_start: 0, audio_end: -1, audio_fade_in: 0, audio_fade_out: 0, override_audio, merge_intensity }),
    });
    if (!r.ok) throw new Error(`Segmind error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `\u2705 Video+Audio merged!\nURL: ${d.output_url || d.url || d.output || JSON.stringify(d)}` }] };
  });

  server.registerTool("segmind_multi_video_merge", {
    title: "Segmind - Multi Video Merge",
    description: "Unisce pi\u00f9 video clip in sequenza.",
    inputSchema: {
      video_urls: z.array(z.string()).describe("Array URL video (min 2, max 10)"),
      transition_type: z.string().default("fade").describe("Transizione: concat, fade, none"),
    },
  }, async ({ video_urls, transition_type }) => {
    const r = await fetch("https://api.segmind.com/v1/multi-video-merge", {
      method: "POST",
      headers: { "x-api-key": KEYS.segmind, "Content-Type": "application/json" },
      body: JSON.stringify({ video_urls, width: 1080, height: 1920, fps: 30, transition_type, transition_duration: 0.5, maintain_aspect_ratio: true, audio_handling: "merge" }),
    });
    if (!r.ok) throw new Error(`Segmind error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `\u2705 ${video_urls.length} video merged!\nURL: ${d.output_url || d.url || d.output || JSON.stringify(d)}` }] };
  });

  // ===== AVVIA SERVER MCP =====
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Use POST." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Paolo AI MCP Server su porta ${PORT}`));
