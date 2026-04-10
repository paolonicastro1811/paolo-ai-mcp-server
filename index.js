import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "50mb" }));

const KEYS = {
  elevenlabs: process.env.ELEVENLABS_API_KEY || "",
  higgsfield: process.env.HIGGSFIELD_API_KEY || "",
  perplexity: process.env.PERPLEXITY_API_KEY || "",
  suno: process.env.SUNO_API_KEY || "",
  heygen: process.env.HEYGEN_API_KEY || "",
  openai: process.env.OPENAI_API_KEY || "",
  segmind: process.env.SEGMIND_API_KEY || "",
  google: process.env.GOOGLE_AI_API_KEY || "",
  piapi: process.env.PIAPI_API_KEY || "",
};

// Limite dimensione allegato Gmail ritornato inline come base64.
// Sopra questo limite il tool ritorna errore invece di riempire il contesto.
const GMAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

// MIME type che Claude può leggere nativamente quando ritornati come resource
// con blob base64 (PDF + immagini standard).
const CLAUDE_NATIVE_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Mappatura estensione -> MIME type per il fallback quando Gmail dichiara
// "application/octet-stream" o un MIME generico inaffidabile.
const EXTENSION_MIME_MAP = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Risolve il MIME type effettivo di un allegato Gmail. Se Gmail dichiara
 * un MIME generico ("application/octet-stream", "binary/octet-stream",
 * stringa vuota), proviamo a dedurlo dall'estensione del filename.
 */
function resolveMimeType(declaredMime, filename) {
  const trustworthy = declaredMime
    && declaredMime !== "application/octet-stream"
    && declaredMime !== "binary/octet-stream";
  if (trustworthy) return declaredMime;
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return EXTENSION_MIME_MAP[ext] || declaredMime || "application/octet-stream";
}

// ============================================================
// GOOGLE WORKSPACE — Helper condivisi (import dinamico)
// ============================================================
// googleapis e @vercel/blob sono pesanti: li carichiamo solo
// quando un tool Google viene effettivamente chiamato.
// ============================================================

let _googleapisCache = null;
let _blobCache = null;

async function loadGoogleapis() {
  if (!_googleapisCache) {
    const mod = await import("googleapis");
    _googleapisCache = mod.google;
  }
  return _googleapisCache;
}

async function loadBlob() {
  if (!_blobCache) {
    _blobCache = await import("@vercel/blob");
  }
  return _blobCache;
}

/**
 * Crea un client OAuth2 Google autenticato usando il refresh token
 * salvato nelle env var. Ritorna un oggetto auth pronto da passare
 * ai costruttori dei servizi Google (gmail, drive, sheets, ecc.).
 */
async function getGoogleAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google credentials mancanti. Verifica GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN su Vercel."
    );
  }

  const google = await loadGoogleapis();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Estrae ricorsivamente tutti gli allegati da un payload Gmail.
 * Gmail annida gli allegati in payload.parts (a volte più livelli).
 */
function extractGmailAttachments(payload, attachments = []) {
  if (!payload) return attachments;
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: payload.body.size,
      attachmentId: payload.body.attachmentId,
    });
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      extractGmailAttachments(part, attachments);
    }
  }
  return attachments;
}

/**
 * Carica un buffer su Vercel Blob come file pubblico e ritorna l'URL.
 * Il nome file viene sanitizzato e prefissato con timestamp.
 * NOTA: usato ancora da drive_download_file e drive_export_google_file
 * (da sistemare in un deploy successivo).
 */
async function uploadBufferToBlob(buffer, filename, folder = "gmail-attachments") {
  const { put } = await loadBlob();
  const timestamp = Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobPath = `${folder}/${timestamp}-${safeFilename}`;
  const blob = await put(blobPath, buffer, {
    access: "public",
    addRandomSuffix: false,
  });
  return blob.url;
}

/**
 * Converte una stringa base64url (usata da Gmail) in Buffer.
 */
function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

// ============================================================
// ROUTES
// ============================================================

app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "Paolo AI MCP Server", version: "2.1.1" });
});

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "paolo-ai-mcp-server", version: "2.1.1" });

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
    const r = await fetch(`https://api.heygen.com/v2/videos/${video_id}`, { headers: { "X-Api-Key": KEYS.heygen } });
    if (!r.ok) throw new Error(`HeyGen error: ${await r.text()}`);
    const d = await r.json();
    const videoData = d.data || {};
    const text = videoData.video_url ? `\u2705 Pronto!\nURL: ${videoData.video_url}` : `\u23f3 Stato: ${videoData.status}`;
    return { content: [{ type: "text", text }] };
  });

  // ===== GEMINI IMAGE (NanoBanana Pro fallback) =====
  server.registerTool("gemini_generate_image", {
    title: "Gemini - Genera Immagine (NanoBanana Pro fallback)",
    description: "Genera immagini con Gemini 2.0 Flash Image — stesso motore di NanoBanana Pro. Usare quando Higgsfield è down.",
    inputSchema: {
      prompt: z.string().describe("Descrizione dell'immagine da generare"),
      aspect_ratio: z.string().default("16:9").describe("Aspect ratio: 1:1, 16:9, 9:16, 4:3"),
    },
  }, async ({ prompt, aspect_ratio }) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${KEYS.google}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      }),
    });
    if (!r.ok) throw new Error(`Gemini error: ${await r.text()}`);
    const d = await r.json();
    const parts = d.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData);
    if (!imgPart) {
      const textPart = parts.find(p => p.text);
      throw new Error(`Nessuna immagine generata. Risposta: ${textPart?.text || JSON.stringify(d)}`);
    }
    const b64 = imgPart.inlineData.data;
    const mimeType = imgPart.inlineData.mimeType;
    return { content: [{ type: "text", text: `✅ Immagine generata!\nMimeType: ${mimeType}\nBase64 (prime 100 chars): ${b64.substring(0, 100)}...\nBase64 completo salvato in: data:${mimeType};base64,${b64}` }] };
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

  // ===== KLING (via PiAPI) =====
  server.registerTool("kling_generate_video", {
    title: "Kling - Genera Video Cinematografico",
    description: "Genera video cinematografici realistici con Kling AI via PiAPI. Supporta text-to-video e image-to-video per consistenza personaggio.",
    inputSchema: {
      prompt: z.string().describe("Descrizione dettagliata della scena da generare"),
      image_url: z.string().optional().describe("URL immagine di riferimento per image-to-video (mantiene consistenza personaggio)"),
      duration: z.number().default(5).describe("Durata in secondi: 5 o 10"),
      aspect_ratio: z.string().default("16:9").describe("Aspect ratio: 16:9, 9:16, 1:1"),
      mode: z.string().default("std").describe("Modalità: std ($0.20/5s) o pro ($0.33/5s)"),
      version: z.string().default("kling-v2-5").describe("Versione modello: kling-v2-5, kling-v2-1, kling-v1-6"),
    },
  }, async ({ prompt, image_url, duration, aspect_ratio, mode, version }) => {
    const input = {
      prompt,
      duration,
      aspect_ratio,
      mode,
      cfg_scale: 0.5,
    };
    if (image_url) input.image_url = image_url;
    const r = await fetch("https://api.piapi.ai/api/v1/task", {
      method: "POST",
      headers: { "x-api-key": KEYS.piapi, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kling",
        task_type: "video_generation",
        input,
      }),
    });
    if (!r.ok) throw new Error(`Kling error: ${await r.text()}`);
    const d = await r.json();
    const taskId = d.data?.task_id;
    return { content: [{ type: "text", text: `🎬 Video Kling in generazione!\nTask ID: ${taskId}\nModello: ${version} (${mode})\nDurata: ${duration}s\nAspect: ${aspect_ratio}\nCosto stimato: ${mode === "pro" ? (duration === 10 ? "0.66" : "0.33") : (duration === 10 ? "0.40" : "0.20")}\n\nUsa kling_check_status con questo Task ID per monitorare.` }] };
  });

  server.registerTool("kling_check_status", {
    title: "Kling - Controlla Stato Video",
    description: "Controlla lo stato di un task Kling e ottieni l'URL del video quando pronto.",
    inputSchema: {
      task_id: z.string().describe("Task ID ottenuto da kling_generate_video"),
    },
  }, async ({ task_id }) => {
    const r = await fetch(`https://api.piapi.ai/api/v1/task/${task_id}`, {
      headers: { "x-api-key": KEYS.piapi },
    });
    if (!r.ok) throw new Error(`Kling error: ${await r.text()}`);
    const d = await r.json();
    const status = d.data?.status;
    const videoUrl = d.data?.output?.video_url;
    if (videoUrl) {
      return { content: [{ type: "text", text: `✅ Video Kling pronto!\nURL: ${videoUrl}\nTask ID: ${task_id}` }] };
    }
    return { content: [{ type: "text", text: `⏳ Stato: ${status}\nTask ID: ${task_id}\nRiprova tra 30-60 secondi.` }] };
  });

  // ===== CHECK CREDITS =====
  server.registerTool("check_credits", {
    title: "Check Credits - Report Saldi API",
    description: "Controlla il credito residuo di tutti i servizi API collegati in un unico report.",
    inputSchema: {},
  }, async () => {
    const results = {};

    try {
      const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
        headers: { "xi-api-key": KEYS.elevenlabs }
      });
      const d = await r.json();
      results.elevenlabs = {
        status: "✅",
        plan: d.tier,
        characters_used: d.character_count,
        characters_limit: d.character_limit,
        characters_remaining: d.character_limit - d.character_count,
      };
    } catch(e) { results.elevenlabs = { status: "❌", error: e.message }; }

    try {
      const r = await fetch("https://api.heygen.com/v2/user/remaining_quota", {
        headers: { "X-Api-Key": KEYS.heygen }
      });
      const d = await r.json();
      results.heygen = { status: "✅", ...(d.data || d) };
    } catch(e) { results.heygen = { status: "❌", error: e.message }; }

    try {
      const r = await fetch("https://api.segmind.com/v1/get-user-credits", {
        headers: { "x-api-key": KEYS.segmind }
      });
      const d = await r.json();
      results.segmind = { status: "✅", ...d };
    } catch(e) { results.segmind = { status: "❌", error: e.message }; }

    try {
      const r = await fetch("https://api.openai.com/v1/organizations", {
        headers: { "Authorization": `Bearer ${KEYS.openai}` }
      });
      results.openai = r.ok
        ? { status: "✅", note: "API attiva — verifica saldo su platform.openai.com/usage" }
        : { status: "⚠️", note: "API key valida ma saldo non recuperabile via API" };
    } catch(e) { results.openai = { status: "❌", error: e.message }; }

    try {
      const r = await fetch(`https://api.apify.com/v2/users/me?token=${process.env.APIFY_API_KEY || ""}`);
      const d = await r.json();
      results.apify = {
        status: "✅",
        plan: d.data?.plan?.id,
        usage_usd: d.data?.monthlyUsage?.totalCostUsd,
        limit_usd: d.data?.plan?.monthlyUsageLimitUsd,
      };
    } catch(e) { results.apify = { status: "❌", error: e.message }; }

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const r = await fetch("https://api.higgsfield.ai/v1/user", {
        headers: { "Authorization": `Bearer ${KEYS.higgsfield}` },
        signal: controller.signal,
      });
      const d = await r.json();
      results.higgsfield = { status: "✅", ...d };
    } catch(e) {
      results.higgsfield = { status: "❌ STILL DOWN", error: "522 Connection Timed Out" };
    }

    results.suno = { status: "ℹ️", note: "Saldo non disponibile via API — verifica su acedata.cloud" };
    results.perplexity = { status: "ℹ️", note: "Saldo non disponibile via API — verifica su perplexity.ai/settings" };

    const report = Object.entries(results)
      .map(([k, v]) => `${v.status} ${k.toUpperCase()}: ${JSON.stringify(v)}`)
      .join("\n");

    return { content: [{ type: "text", text: `📊 REPORT CREDITI — ${new Date().toISOString()}\n\n${report}` }] };
  });

  // ============================================================
  // ===== GOOGLE WORKSPACE TOOLS =====
  // ============================================================

  // ----- DIAGNOSTICA -----
  server.registerTool("google_test_auth", {
    title: "Google - Test Autenticazione",
    description: "Verifica che le credenziali Google OAuth siano valide e restituisce email dell'account e scope autorizzati. Usa questo tool per diagnosticare problemi di autenticazione.",
    inputSchema: {},
  }, async () => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const oauth2 = google.oauth2({ version: "v2", auth });
      const userInfo = await oauth2.userinfo.get();
      const tokenInfo = await auth.getAccessToken();
      return {
        content: [{
          type: "text",
          text: `✅ Google OAuth OK\n\nAccount: ${userInfo.data.email}\nNome: ${userInfo.data.name}\nAccess token ottenuto: ${tokenInfo.token ? "sì" : "no"}\n\nLe credenziali funzionano correttamente.`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ Errore autenticazione Google: ${err.message}` }],
        isError: true
      };
    }
  });

  // ----- GMAIL -----
  server.registerTool("gmail_list_attachments", {
    title: "Gmail - Elenca Allegati",
    description: "Elenca tutti gli allegati di un'email Gmail dato il messageId. Restituisce filename, mimeType, size e attachmentId per ciascun allegato. Usa poi gmail_download_attachment per scaricarne uno.",
    inputSchema: {
      message_id: z.string().describe("ID del messaggio Gmail (es. 19c8c548c0c40869)"),
    },
  }, async ({ message_id }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const msg = await gmail.users.messages.get({ userId: "me", id: message_id, format: "full" });
      const attachments = extractGmailAttachments(msg.data.payload);
      if (attachments.length === 0) {
        return { content: [{ type: "text", text: `Nessun allegato trovato nel messaggio ${message_id}.` }] };
      }
      const summary = attachments.map((a, i) =>
        `${i + 1}. ${a.filename}\n   mimeType: ${a.mimeType}\n   size: ${(a.size / 1024).toFixed(1)} KB\n   attachmentId: ${a.attachmentId}`
      ).join("\n\n");
      return { content: [{ type: "text", text: `📎 ${attachments.length} allegati nel messaggio ${message_id}:\n\n${summary}\n\nUsa gmail_download_attachment con message_id + attachment_id + filename per scaricare.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail error: ${err.message}` }], isError: true };
    }
  });

  // === gmail_download_attachment — VERSIONE INLINE BASE64 ===
  // Scarica l'allegato da Gmail e lo ritorna direttamente come contenuto
  // MCP "resource" con blob base64, senza passare per Vercel Blob.
  // Claude legge nativamente PDF e immagini ricevuti in questo modo.
  server.registerTool("gmail_download_attachment", {
    title: "Gmail - Scarica Allegato (inline)",
    description: "Scarica un allegato da un'email Gmail e lo restituisce direttamente inline come resource base64. Claude può leggere nativamente PDF, PNG, JPEG, GIF e WebP. Per altri formati (Excel, ZIP, ecc.) ritorna metadati + base64 ma senza rendering nativo. Nessun URL pubblico generato: i dati restano privati nella conversazione.",
    inputSchema: {
      message_id: z.string().describe("ID del messaggio Gmail"),
      attachment_id: z.string().describe("ID dell'allegato (da gmail_list_attachments)"),
      filename: z.string().describe("Nome file originale"),
    },
  }, async ({ message_id, attachment_id, filename }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });

      // Scarica il contenuto dell'allegato (base64url)
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: message_id,
        id: attachment_id,
      });
      if (!att.data.data) {
        throw new Error("Nessun dato ricevuto da Gmail per questo allegato");
      }

      // Decodifica base64url -> Buffer per calcolare dimensione e validare
      const buffer = base64urlToBuffer(att.data.data);
      const sizeBytes = buffer.length;
      const sizeKB = (sizeBytes / 1024).toFixed(1);
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

      // Controllo limite dimensione
      if (sizeBytes > GMAIL_ATTACHMENT_MAX_BYTES) {
        const limitMB = (GMAIL_ATTACHMENT_MAX_BYTES / 1024 / 1024).toFixed(0);
        return {
          content: [{
            type: "text",
            text: `❌ Allegato troppo grande per ritorno inline.\n\n📄 File: ${filename}\n📊 Dimensione: ${sizeMB} MB\n⚠️ Limite: ${limitMB} MB\n\nPer file oltre il limite, scarica manualmente da Gmail.`
          }],
          isError: true,
        };
      }

      // Ricava il mimeType dal messaggio Gmail (più affidabile dell'estensione)
      const msgMeta = await gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "full",
      });
      const allAtts = extractGmailAttachments(msgMeta.data.payload);
      const matched = allAtts.find(a => a.attachmentId === attachment_id);
      const declaredMime = matched?.mimeType || "application/octet-stream";
      const mimeType = resolveMimeType(declaredMime, filename);

      // Base64 standard (non base64url) per il protocollo MCP
      const base64Standard = buffer.toString("base64");

      // Se è un formato che Claude sa leggere nativamente, ritornalo
      // come resource embedded -> Claude lo processa come un upload.
      if (CLAUDE_NATIVE_MIMES.has(mimeType)) {
        return {
          content: [
            {
              type: "text",
              text: `✅ Allegato scaricato inline\n\n📄 ${filename}\n📊 ${sizeKB} KB\n🏷️ ${mimeType}\n\nIl file è allegato qui sotto per la lettura diretta.`,
            },
            {
              type: "resource",
              resource: {
                uri: `gmail://message/${message_id}/attachment/${attachment_id}/${encodeURIComponent(filename)}`,
                mimeType,
                blob: base64Standard,
              },
            },
          ],
        };
      }

      // Formato non nativo: ritorna i metadati e il base64 in un resource
      // comunque, così chi riceve può decidere cosa farne.
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Allegato scaricato ma formato non visualizzabile nativamente\n\n📄 ${filename}\n📊 ${sizeKB} KB\n🏷️ ${mimeType}\n\nI dati sono allegati come resource base64 ma Claude non può leggerli direttamente. Formati supportati nativamente: PDF, PNG, JPEG, GIF, WebP.`,
          },
          {
            type: "resource",
            resource: {
              uri: `gmail://message/${message_id}/attachment/${attachment_id}/${encodeURIComponent(filename)}`,
              mimeType,
              blob: base64Standard,
            },
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ Gmail download error: ${err.message}` }],
        isError: true,
      };
    }
  });

  server.registerTool("gmail_send_message", {
    title: "Gmail - Invia Email",
    description: "Invia un'email dal tuo account Gmail. Supporta destinatari multipli, CC, BCC, e corpo in testo semplice o HTML.",
    inputSchema: {
      to: z.string().describe("Destinatario/i, separati da virgola se multipli"),
      subject: z.string().describe("Oggetto dell'email"),
      body: z.string().describe("Corpo dell'email (testo o HTML)"),
      cc: z.string().optional().describe("CC (opzionale, separati da virgola)"),
      bcc: z.string().optional().describe("BCC (opzionale, separati da virgola)"),
      is_html: z.boolean().default(false).describe("True se body è HTML, false per testo"),
    },
  }, async ({ to, subject, body, cc, bcc, is_html }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const headers = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        bcc ? `Bcc: ${bcc}` : null,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        "MIME-Version: 1.0",
        is_html ? "Content-Type: text/html; charset=UTF-8" : "Content-Type: text/plain; charset=UTF-8",
      ].filter(Boolean).join("\r\n");
      const rawMessage = `${headers}\r\n\r\n${body}`;
      const encodedMessage = Buffer.from(rawMessage).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const result = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encodedMessage },
      });
      return { content: [{ type: "text", text: `✅ Email inviata\nMessage ID: ${result.data.id}\nA: ${to}\nOggetto: ${subject}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail send error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("gmail_create_draft", {
    title: "Gmail - Crea Bozza",
    description: "Crea una bozza email nel tuo account Gmail senza inviarla. Utile per preparare email che poi invierai manualmente.",
    inputSchema: {
      to: z.string().describe("Destinatario"),
      subject: z.string().describe("Oggetto"),
      body: z.string().describe("Corpo (testo o HTML)"),
      is_html: z.boolean().default(false).describe("True se HTML"),
    },
  }, async ({ to, subject, body, is_html }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const headers = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        "MIME-Version: 1.0",
        is_html ? "Content-Type: text/html; charset=UTF-8" : "Content-Type: text/plain; charset=UTF-8",
      ].join("\r\n");
      const rawMessage = `${headers}\r\n\r\n${body}`;
      const encodedMessage = Buffer.from(rawMessage).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const result = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: encodedMessage } },
      });
      return { content: [{ type: "text", text: `✅ Bozza creata\nDraft ID: ${result.data.id}\nA: ${to}\nOggetto: ${subject}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail draft error: ${err.message}` }], isError: true };
    }
  });

  // ----- GOOGLE DRIVE -----
  server.registerTool("drive_download_file", {
    title: "Drive - Scarica File",
    description: "Scarica un file da Google Drive (qualsiasi formato: PDF, Excel, Word, immagini, ZIP) e lo carica su Vercel Blob, restituendo un URL pubblico. Per Google Docs/Sheets/Slides usa drive_export_google_file.",
    inputSchema: {
      file_id: z.string().describe("ID del file su Drive"),
      filename: z.string().optional().describe("Nome file da usare (se omesso, usa il nome su Drive)"),
    },
  }, async ({ file_id, filename }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });
      const meta = await drive.files.get({ fileId: file_id, fields: "name,mimeType,size" });
      if (meta.data.mimeType?.startsWith("application/vnd.google-apps")) {
        return { content: [{ type: "text", text: `⚠️ Questo è un file Google nativo (${meta.data.mimeType}). Usa drive_export_google_file per esportarlo in PDF/Excel/Word.` }], isError: true };
      }
      const fileResp = await drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "arraybuffer" });
      const buffer = Buffer.from(fileResp.data);
      const finalName = filename || meta.data.name || `drive_${file_id}`;
      const url = await uploadBufferToBlob(buffer, finalName, "drive-files");
      return { content: [{ type: "text", text: `✅ File Drive scaricato\n\n📄 ${meta.data.name}\n📊 ${(buffer.length / 1024).toFixed(1)} KB\n🔗 ${url}\n\nUsa web_fetch su questo URL per leggere il contenuto.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Drive download error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("drive_export_google_file", {
    title: "Drive - Esporta File Google",
    description: "Esporta un file Google nativo (Docs, Sheets, Slides) in un formato standard (PDF, XLSX, DOCX, PPTX) e lo carica su Blob. Per file non-Google usa drive_download_file.",
    inputSchema: {
      file_id: z.string().describe("ID del file Google Doc/Sheet/Slides"),
      export_format: z.string().default("pdf").describe("Formato: pdf, xlsx, docx, pptx, csv, txt, html"),
    },
  }, async ({ file_id, export_format }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });
      const meta = await drive.files.get({ fileId: file_id, fields: "name,mimeType" });
      const mimeMap = {
        pdf: "application/pdf",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        csv: "text/csv",
        txt: "text/plain",
        html: "text/html",
      };
      const targetMime = mimeMap[export_format.toLowerCase()];
      if (!targetMime) throw new Error(`Formato non supportato: ${export_format}. Usa: pdf, xlsx, docx, pptx, csv, txt, html`);
      const exportResp = await drive.files.export({ fileId: file_id, mimeType: targetMime }, { responseType: "arraybuffer" });
      const buffer = Buffer.from(exportResp.data);
      const safeName = (meta.data.name || "export").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${safeName}.${export_format.toLowerCase()}`;
      const url = await uploadBufferToBlob(buffer, filename, "drive-exports");
      return { content: [{ type: "text", text: `✅ File Google esportato in ${export_format.toUpperCase()}\n\n📄 ${meta.data.name} → ${filename}\n📊 ${(buffer.length / 1024).toFixed(1)} KB\n🔗 ${url}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Drive export error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("drive_list_folder", {
    title: "Drive - Elenca Contenuto Cartella",
    description: "Elenca file e sottocartelle di una cartella Google Drive. Per la root usa 'root' come folder_id.",
    inputSchema: {
      folder_id: z.string().default("root").describe("ID cartella (usa 'root' per la root del Drive)"),
      max_results: z.number().default(50).describe("Numero massimo di risultati (max 1000)"),
    },
  }, async ({ folder_id, max_results }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });
      const resp = await drive.files.list({
        q: `'${folder_id}' in parents and trashed = false`,
        pageSize: max_results,
        fields: "files(id,name,mimeType,size,modifiedTime)",
        orderBy: "modifiedTime desc",
      });
      const files = resp.data.files || [];
      if (files.length === 0) return { content: [{ type: "text", text: `Nessun file in cartella ${folder_id}` }] };
      const text = files.map(f => {
        const isFolder = f.mimeType === "application/vnd.google-apps.folder";
        const sizeStr = f.size ? `${(f.size / 1024).toFixed(1)} KB` : "—";
        return `${isFolder ? "📁" : "📄"} ${f.name}\n   id: ${f.id}\n   mime: ${f.mimeType}\n   size: ${sizeStr}\n   modified: ${f.modifiedTime}`;
      }).join("\n\n");
      return { content: [{ type: "text", text: `📂 ${files.length} elementi in cartella ${folder_id}:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Drive list error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("drive_search", {
    title: "Drive - Ricerca Avanzata",
    description: "Cerca file su Google Drive con query avanzata (full-text + filtri). Esempi: 'name contains \"polizza\"', 'mimeType = \"application/pdf\"', 'modifiedTime > \"2026-01-01\"'.",
    inputSchema: {
      query: z.string().describe("Query Drive API (vedi https://developers.google.com/drive/api/guides/search-files)"),
      max_results: z.number().default(20).describe("Numero massimo risultati"),
    },
  }, async ({ query, max_results }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });
      const resp = await drive.files.list({
        q: query,
        pageSize: max_results,
        fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
      });
      const files = resp.data.files || [];
      if (files.length === 0) return { content: [{ type: "text", text: `Nessun risultato per query: ${query}` }] };
      const text = files.map(f => `📄 ${f.name}\n   id: ${f.id}\n   mime: ${f.mimeType}\n   link: ${f.webViewLink}`).join("\n\n");
      return { content: [{ type: "text", text: `🔍 ${files.length} risultati:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Drive search error: ${err.message}` }], isError: true };
    }
  });

  // ----- GOOGLE SHEETS -----
  server.registerTool("sheets_read_range", {
    title: "Sheets - Leggi Range",
    description: "Legge un range di celle da un Google Sheet. Range in notazione A1 (es. 'Foglio1!A1:D10' o 'A1:Z100').",
    inputSchema: {
      spreadsheet_id: z.string().describe("ID dello spreadsheet (dall'URL del Sheet)"),
      range: z.string().describe("Range A1 (es. 'Foglio1!A1:D10')"),
    },
  }, async ({ spreadsheet_id, range }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const sheets = google.sheets({ version: "v4", auth });
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheet_id, range });
      const values = resp.data.values || [];
      if (values.length === 0) return { content: [{ type: "text", text: `Nessun dato nel range ${range}` }] };
      const text = values.map((row, i) => `Riga ${i + 1}: ${JSON.stringify(row)}`).join("\n");
      return { content: [{ type: "text", text: `📊 ${values.length} righe lette da ${range}:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Sheets read error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("sheets_write_range", {
    title: "Sheets - Scrivi Range",
    description: "Scrive valori in un range specifico di un Google Sheet. Sovrascrive i valori esistenti nel range. Usa sheets_append_row per aggiungere righe in fondo.",
    inputSchema: {
      spreadsheet_id: z.string().describe("ID dello spreadsheet"),
      range: z.string().describe("Range A1 dove scrivere (es. 'Foglio1!A1:C3')"),
      values: z.array(z.array(z.any())).describe("Array 2D di valori. Ogni sotto-array è una riga. Es: [['Nome','Età'],['Paolo',38]]"),
    },
  }, async ({ spreadsheet_id, range, values }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const sheets = google.sheets({ version: "v4", auth });
      const resp = await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
      return { content: [{ type: "text", text: `✅ Scritte ${resp.data.updatedCells} celle in ${resp.data.updatedRange}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Sheets write error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("sheets_append_row", {
    title: "Sheets - Aggiungi Riga",
    description: "Appende una o più righe in fondo a un Google Sheet. Ideale per log, tracking clienti, CRM, registro attività.",
    inputSchema: {
      spreadsheet_id: z.string().describe("ID dello spreadsheet"),
      range: z.string().describe("Range che identifica la tabella (es. 'Foglio1!A:Z')"),
      values: z.array(z.array(z.any())).describe("Array 2D di righe da aggiungere. Es: [['2026-04-10','Cliente X','Pagamento']]"),
    },
  }, async ({ spreadsheet_id, range, values }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const sheets = google.sheets({ version: "v4", auth });
      const resp = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
      return { content: [{ type: "text", text: `✅ Righe appese: ${values.length}\nRange aggiornato: ${resp.data.updates?.updatedRange}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Sheets append error: ${err.message}` }], isError: true };
    }
  });

  // ----- GOOGLE DOCS -----
  server.registerTool("docs_read", {
    title: "Docs - Leggi Documento",
    description: "Legge il contenuto testuale di un Google Doc. Restituisce tutto il testo del documento in sequenza. Per export in PDF usa drive_export_google_file.",
    inputSchema: {
      document_id: z.string().describe("ID del Google Doc (dall'URL)"),
    },
  }, async ({ document_id }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const docs = google.docs({ version: "v1", auth });
      const doc = await docs.documents.get({ documentId: document_id });
      const content = doc.data.body?.content || [];
      const text = content.map(block => {
        if (block.paragraph) {
          return (block.paragraph.elements || []).map(e => e.textRun?.content || "").join("");
        }
        return "";
      }).join("");
      return { content: [{ type: "text", text: `📄 ${doc.data.title}\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Docs read error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("docs_append_text", {
    title: "Docs - Aggiungi Testo",
    description: "Appende testo in fondo a un Google Doc esistente. Utile per log, note progressive, diari, registri.",
    inputSchema: {
      document_id: z.string().describe("ID del Google Doc"),
      text: z.string().describe("Testo da appendere"),
    },
  }, async ({ document_id, text }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const docs = google.docs({ version: "v1", auth });
      const doc = await docs.documents.get({ documentId: document_id });
      const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex || 1;
      await docs.documents.batchUpdate({
        documentId: document_id,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: endIndex - 1 },
              text: `\n${text}`,
            },
          }],
        },
      });
      return { content: [{ type: "text", text: `✅ Testo appeso al documento "${doc.data.title}"` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Docs append error: ${err.message}` }], isError: true };
    }
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
