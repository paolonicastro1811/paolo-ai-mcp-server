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
 * I blob vengono automaticamente eliminati dopo 24h dal cron job
 * POST /cleanup-blobs (vedi vercel.json).
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

/**
 * Recupera il valore di un header specifico da un array di headers Gmail.
 */
function gmailGetHeader(headers, name) {
  if (!Array.isArray(headers)) return "";
  const h = headers.find(h => h?.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

/**
 * Estrae il corpo testo/HTML da un payload Gmail (ricorsivo su parts).
 */
function extractGmailBody(payload) {
  let plain = "", html = "";
  function walk(p) {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) {
      plain += base64urlToBuffer(p.body.data).toString("utf-8");
    } else if (p.mimeType === "text/html" && p.body?.data) {
      html += base64urlToBuffer(p.body.data).toString("utf-8");
    }
    if (Array.isArray(p.parts)) for (const part of p.parts) walk(part);
  }
  walk(payload);
  return { plain, html };
}


/**
 * Carica un Buffer su Google Drive in una cartella specifica.
 * Usa la stessa autenticazione OAuth dei tool Drive esistenti.
 *
 * @param {Buffer} buffer - Il contenuto del file da caricare
 * @param {string} filename - Nome del file su Drive
 * @param {string} folderId - ID della cartella Drive di destinazione
 * @param {string} mimeType - MIME type del file (es. "audio/mpeg" per MP3)
 * @returns {Promise<{fileId: string, webViewLink: string, webContentLink: string}>}
 */
async function uploadBufferToDrive(buffer, filename, folderId, mimeType) {
  const google = await loadGoogleapis();
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: "v3", auth });

  // Sanitizza il filename per Drive (Drive accetta più caratteri di Blob, ma evitiamo /)
  const safeFilename = filename.replace(/[/\\]/g, "_");

  // Crea il file su Drive con metadata + content multipart
  // Usiamo Readable.from() per convertire il Buffer in stream per googleapis
  const { Readable } = await import("stream");

  const resp = await drive.files.create({
    requestBody: {
      name: safeFilename,
      parents: folderId ? [folderId] : undefined,
      mimeType,
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: "id,name,webViewLink,webContentLink,size",
  });

  return {
    fileId: resp.data.id,
    name: resp.data.name,
    webViewLink: resp.data.webViewLink,
    webContentLink: resp.data.webContentLink,
    size: resp.data.size,
  };
}

// ============================================================
// OPENAI AUDIO — Helper condivisi
// ============================================================
// Helper usati dai tool openai_text_to_speech e openai_generate_podcast.
// Niente SDK OpenAI: usiamo fetch nativo come per gli altri tool del server.
// ============================================================

/**
 * Catalogo delle voci OpenAI TTS con descrizioni in italiano e use case.
 * Usato da openai_list_voices.
 */
const OPENAI_VOICES_CATALOG = {
  marin:   { description: "Top quality, equilibrata e naturale.",                                  best_for: "podcast professionali, audiolibri" },
  cedar:   { description: "Top quality, calda e autorevole.",                                      best_for: "corsi, lezioni, contenuti formativi" },
  alloy:   { description: "Neutra e versatile, buona per qualsiasi contenuto generale.",           best_for: "generico, demo, prototipi" },
  ash:     { description: "Maschile, sicura e professionale.",                                     best_for: "business, presentazioni" },
  ballad:  { description: "Espressiva ed emotiva, perfetta per storytelling.",                     best_for: "storytelling, narrativa" },
  coral:   { description: "Calda e accogliente, ottima per italiano conversazionale.",             best_for: "conversazione informale, tutorial italiani" },
  echo:    { description: "Maschile profonda, autorevole e leggermente formale.",                  best_for: "documentari, news" },
  fable:   { description: "Calda e narrativa, perfetta per storie e fiabe.",                       best_for: "storytelling, fiabe, audiolibri" },
  nova:    { description: "Energica e coinvolgente, dinamica. Buona per italiano vivace.",         best_for: "marketing, contenuti social, podcast energici" },
  onyx:    { description: "Maschile profonda e autorevole, educational e seria.",                  best_for: "educational, documentari seri" },
  sage:    { description: "Calma e riflessiva, perfetta per meditazione o consigli.",              best_for: "meditazione, mindfulness, advice" },
  shimmer: { description: "Femminile dolce e gentile, ottima per italiano rilassante.",            best_for: "wellness, relax, contenuti calmi" },
  verse:   { description: "Versatile ed espressiva, supporta una vasta gamma di toni.",            best_for: "multi-purpose, adattabile a vari contesti" },
};

const OPENAI_VOICES_LIST = Object.keys(OPENAI_VOICES_CATALOG);

/**
 * Spezza un testo lungo in chunk rispettando i confini naturali del testo.
 * Strategia: prova prima a tagliare a fine paragrafo, poi a fine frase,
 * infine — solo se proprio necessario — a fine parola.
 *
 * @param {string} text - Il testo da spezzare
 * @param {number} maxChars - Limite massimo caratteri per chunk
 * @returns {string[]} Array di chunk
 */
function splitTextIntoChunks(text, maxChars) {
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks = [];
  let remaining = cleaned;

  while (remaining.length > maxChars) {
    let cutAt = -1;

    // 1) Prova a tagliare a fine paragrafo nei primi maxChars caratteri
    const paraEnd = remaining.lastIndexOf("\n\n", maxChars);
    if (paraEnd > maxChars * 0.5) {
      cutAt = paraEnd + 2;
    }

    // 2) Altrimenti prova a fine frase
    if (cutAt === -1) {
      const sentenceEnders = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
      let bestEnd = -1;
      for (const ender of sentenceEnders) {
        const idx = remaining.lastIndexOf(ender, maxChars);
        if (idx > bestEnd) bestEnd = idx;
      }
      if (bestEnd > maxChars * 0.5) {
        cutAt = bestEnd + 2;
      }
    }

    // 3) Fallback: taglia a fine parola
    if (cutAt === -1) {
      const wordEnd = remaining.lastIndexOf(" ", maxChars);
      cutAt = wordEnd > 0 ? wordEnd + 1 : maxChars;
    }

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Chiama OpenAI TTS API per un singolo chunk di testo e ritorna il Buffer MP3.
 * Usa fetch nativo (no SDK). Il parametro 'instructions' viene incluso solo
 * se il modello è gpt-4o-mini-tts (gli altri lo ignorerebbero).
 */
async function openaiTTSChunk({ text, voice, model, speed, instructions }) {
  const payload = {
    model,
    voice,
    input: text,
    speed,
    response_format: "mp3",
  };
  if (model === "gpt-4o-mini-tts" && instructions) {
    payload.instructions = instructions;
  }

  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEYS.openai}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI TTS error (${r.status}): ${errText}`);
  }

  const arrayBuffer = await r.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================
// ROUTES
// ============================================================

app.get("/", (_req, res) => {
  res.json({ status: "ok", server: "Paolo AI MCP Server", version: "2.4.0" });
});

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "paolo-ai-mcp-server", version: "2.4.0" });

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
    return { content: [{ type: "text", text: `✅ Audio generato con voce ${voice_id} per il testo: "${text.substring(0, 50)}..."` }] };
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
    return { content: [{ type: "text", text: `🎨 Immagine generata!\nURL: ${d.data[0].url}` }] };
  });

  // ===== OPENAI AUDIO (TTS + Podcast) =====

  server.registerTool("openai_list_voices", {
    title: "OpenAI - Lista Voci TTS",
    description: "Elenca tutte le voci OpenAI TTS disponibili (13 totali) con descrizioni in italiano e suggerimenti d'uso. USA QUESTO TOOL prima di generare audio o podcast quando l'utente non ha specificato una voce, o quando chiede consigli su quale voce scegliere per un contenuto. Restituisce nome voce, descrizione e use case ideale.",
    inputSchema: {},
  }, async () => {
    const list = Object.entries(OPENAI_VOICES_CATALOG).map(([name, info]) =>
      `🎙️ ${name.padEnd(8)} — ${info.description}\n           Ideale per: ${info.best_for}`
    ).join("\n\n");
    const note = `\n\nNote importanti:\n• marin e cedar sono le voci top-quality di OpenAI (raccomandate per podcast professionali, disponibili solo con modello gpt-4o-mini-tts)\n• Per italiano conversazionale: nova, coral, shimmer\n• Per italiano professionale/educational: cedar, onyx, ash\n• Tutte le voci supportano italiano ma sono primariamente ottimizzate per inglese\n• Per qualità top in italiano resta superiore ElevenLabs (usa elevenlabs_text_to_speech)`;
    return { content: [{ type: "text", text: `Voci OpenAI TTS disponibili (${OPENAI_VOICES_LIST.length} totali):\n\n${list}${note}` }] };
  });

  server.registerTool("openai_text_to_speech", {
    title: "OpenAI - Text to Speech",
    description: "Converte testo in audio MP3 usando OpenAI TTS. Carica il file su Vercel Blob (cleanup automatico dopo 24h) e restituisce un URL pubblico. USA QUESTO TOOL quando: (1) l'utente vuole un audio breve singolo (max 4096 caratteri per tts-1/tts-1-hd, max ~7500 per gpt-4o-mini-tts), (2) preferisce esplicitamente OpenAI invece di ElevenLabs, (3) il volume di testo è alto e il costo conta (OpenAI ~10x più economico di ElevenLabs), (4) vuole controllare tono ed emozione con il parametro 'instructions' (solo gpt-4o-mini-tts). NON usare per podcast lunghi (>4000 caratteri): usa openai_generate_podcast invece. Per qualità top voce italiana resta meglio elevenlabs_text_to_speech.",
    inputSchema: {
      text: z.string().describe("Testo da convertire in audio. Max 4096 caratteri per tts-1/tts-1-hd, max ~7500 per gpt-4o-mini-tts."),
      voice: z.enum(OPENAI_VOICES_LIST).default("nova").describe("Voce OpenAI. Default: nova (energica, ottima per italiano). Usa openai_list_voices per consigli."),
      model: z.enum(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]).default("gpt-4o-mini-tts").describe("Modello TTS. tts-1 economico, tts-1-hd qualità superiore, gpt-4o-mini-tts il più recente con supporto a 'instructions' per controllare tono."),
      speed: z.number().min(0.25).max(4.0).default(1.0).describe("Velocità lettura. 0.25 lentissimo, 1.0 normale, 4.0 velocissimo."),
      instructions: z.string().optional().describe("SOLO per gpt-4o-mini-tts: istruzioni in linguaggio naturale per tono/emozione/pacing. Esempi: 'Parla con tono caldo e rilassato', 'Suona entusiasta come un presentatore radio'. Ignorato per tts-1 e tts-1-hd."),
    },
  }, async ({ text, voice, model, speed, instructions }) => {
    // Validazione limite caratteri specifico per modello
    if ((model === "tts-1" || model === "tts-1-hd") && text.length > 4096) {
      return {
        content: [{ type: "text", text: `❌ Errore: il modello ${model} ha un limite massimo di 4096 caratteri per richiesta. Il testo fornito ha ${text.length} caratteri.\n\nSoluzioni:\n• Usa il modello gpt-4o-mini-tts (limite ~7500 caratteri)\n• Usa openai_generate_podcast che spezza automaticamente i testi lunghi` }],
        isError: true,
      };
    }
    if (model === "gpt-4o-mini-tts" && text.length > 7500) {
      return {
        content: [{ type: "text", text: `❌ Errore: il modello gpt-4o-mini-tts ha un limite di ~7500 caratteri. Il testo fornito ha ${text.length} caratteri.\n\nUsa openai_generate_podcast che spezza automaticamente i testi lunghi.` }],
        isError: true,
      };
    }

    try {
      const t0 = Date.now();
      const buffer = await openaiTTSChunk({ text, voice, model, speed, instructions });
      const filename = `openai_${voice}_${model}.mp3`;
      const url = await uploadBufferToBlob(buffer, filename, "tts-podcasts");
      const durationMs = Date.now() - t0;
      const sizeKB = Math.round(buffer.length / 1024);

      return {
        content: [{
          type: "text",
          text: `✅ Audio TTS generato\n\n🔗 URL: ${url}\n\n📊 Dettagli:\n• Voce: ${voice}\n• Modello: ${model}\n• Velocità: ${speed}x${instructions ? `\n• Istruzioni tono: ${instructions}` : ""}\n• Caratteri: ${text.length}\n• Dimensione: ${sizeKB} KB\n• Tempo generazione: ${(durationMs / 1000).toFixed(1)}s\n\n⚠️ Policy OpenAI: se condividi questo audio con altri utenti, dichiara sempre che la voce è AI-generated.`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ OpenAI TTS error: ${err.message}\n\nPossibili cause:\n• OPENAI_API_KEY non valida o mancante su Vercel\n• Quota OpenAI esaurita (verifica platform.openai.com/usage)\n• Modello non disponibile sul tuo account\n• Problema di rete temporaneo` }],
        isError: true,
      };
    }
  });

  server.registerTool("openai_generate_podcast", {
    title: "OpenAI - Genera Podcast",
    description: "Genera un podcast completo da uno script lungo (anche 50.000+ caratteri). Pipeline automatica: (1) split intelligente in chunk rispettando confini di paragrafo e frase, (2) generazione audio in PARALLELO per tutti i chunk con OpenAI TTS, (3) concatenazione dei MP3 in singolo file, (4) upload su Vercel Blob, (5) URL pubblico singolo. OPZIONALE: con upload_to_drive=true salva una copia permanente nella cartella Google Drive configurata in DRIVE_PODCAST_FOLDER_ID (o in una cartella custom se passi drive_folder_id). USA QUESTO TOOL quando l'utente vuole generare podcast/audiolibri/episodi da script lunghi, quando il testo supera i 4000 caratteri, o quando parla esplicitamente di 'podcast', 'episodio', 'audio lungo', 'narrazione completa'. Quando l'utente dice 'mandalo su Drive' o 'salvalo permanentemente' o 'voglio conservarlo', attiva upload_to_drive=true. Costo indicativo: episodio 10 minuti (~9000 caratteri) con gpt-4o-mini-tts circa $0.10-0.15. Tempo: 15-40 secondi tipici (più 3-5s extra se upload_to_drive=true). ATTENZIONE timeout Vercel: Hobby plan 10s, Pro plan 60s.",
    inputSchema: {
      script: z.string().describe("Script completo del podcast in italiano (o altra lingua). Può contenere paragrafi multipli, viene spezzato automaticamente. Min 100, max 100.000 caratteri."),
      voice: z.enum(OPENAI_VOICES_LIST).default("nova").describe("Voce per la narrazione. Default nova. Per podcast professionali considera marin o cedar (top quality, solo gpt-4o-mini-tts)."),
      model: z.enum(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]).default("gpt-4o-mini-tts").describe("Modello TTS. Per podcast pubblicabili usa gpt-4o-mini-tts o tts-1-hd. Per draft veloci ed economici usa tts-1."),
      speed: z.number().min(0.25).max(4.0).default(1.0).describe("Velocità narrazione. Per podcast italiani consiglio 1.0 (normale) o 0.95 (leggermente più lento per chiarezza)."),
      instructions: z.string().optional().describe("SOLO per gpt-4o-mini-tts: istruzioni di tono per tutto il podcast. Esempi: 'Tono conversazionale come un host di podcast esperto', 'Lettura calma da audiolibro'. Applicato a tutti i chunk per consistenza."),
      episode_title: z.string().optional().describe("Titolo opzionale dell'episodio, usato nel filename del MP3 finale (es. 'PDF1_capitolo8_allucinazioni')."),
      upload_to_drive: z.boolean().default(false).describe("Se true, dopo l'upload su Vercel Blob carica una copia PERMANENTE su Google Drive nella cartella configurata in DRIVE_PODCAST_FOLDER_ID. Usa true quando l'utente vuole conservare il podcast (es. 'mandalo su Drive', 'salvalo permanentemente', 'voglio ascoltarlo dal telefono'). Default false."),
      drive_folder_id: z.string().optional().describe("ID della cartella Google Drive dove caricare il podcast. Se omesso, usa DRIVE_PODCAST_FOLDER_ID (env var). Specifica solo se vuoi una cartella diversa dal default. Ignorato se upload_to_drive=false."),
    },
  }, async ({ script, voice, model, speed, instructions, episode_title, upload_to_drive, drive_folder_id }) => {
    if (script.length < 100) {
      return {
        content: [{ type: "text", text: `❌ Errore: lo script deve avere almeno 100 caratteri. Lunghezza fornita: ${script.length}.\n\nPer testi brevi usa openai_text_to_speech.` }],
        isError: true,
      };
    }
    if (script.length > 100000) {
      return {
        content: [{ type: "text", text: `❌ Errore: lo script supera il limite di 100.000 caratteri (lunghezza: ${script.length}).\n\nSpezza in più episodi e generali separatamente.` }],
        isError: true,
      };
    }

    const t0 = Date.now();

    try {
      // Determina dimensione max per chunk in base al modello
      const maxCharsPerChunk = model === "gpt-4o-mini-tts" ? 7000 : 3800;

      // Spezza lo script in chunk intelligenti
      const chunks = splitTextIntoChunks(script, maxCharsPerChunk);

      // Genera audio per tutti i chunk in PARALLELO
      const audioBuffers = await Promise.all(
        chunks.map(chunk =>
          openaiTTSChunk({ text: chunk, voice, model, speed, instructions })
        )
      );

      // Concatena i Buffer MP3 in un unico file
      // Funziona perché OpenAI produce MP3 con stesso encoding,
      // e i frame MP3 sono autonomi (i player ignorano gli ID3 intermedi).
      const fullAudioBuffer = Buffer.concat(audioBuffers);

      // Genera filename descrittivo
      const safeTitle = (episode_title || "podcast")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 50);
      const filename = `${safeTitle}_${voice}.mp3`;

      // Upload su Vercel Blob (folder tts-podcasts/) — sempre eseguito
      const blobUrl = await uploadBufferToBlob(fullAudioBuffer, filename, "tts-podcasts");
      const tBlobDone = Date.now();

      // Upload su Google Drive — solo se richiesto
      let driveResult = null;
      let driveError = null;
      if (upload_to_drive) {
        const targetFolderId = drive_folder_id || process.env.DRIVE_PODCAST_FOLDER_ID;
        if (!targetFolderId) {
          driveError = "DRIVE_PODCAST_FOLDER_ID non configurato sulle env var Vercel e nessun drive_folder_id passato come parametro. Il file è comunque su Vercel Blob (link sopra).";
        } else {
          try {
            // Filename Drive: includiamo timestamp ISO leggibile per ordinamento
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const driveFilename = `${timestamp}_${filename}`;
            driveResult = await uploadBufferToDrive(fullAudioBuffer, driveFilename, targetFolderId, "audio/mpeg");
          } catch (driveErr) {
            driveError = `Upload Drive fallito: ${driveErr.message}. Il file è comunque disponibile su Vercel Blob (link sopra).`;
          }
        }
      }

      const durationMs = Date.now() - t0;
      const blobMs = tBlobDone - t0;
      const driveMs = upload_to_drive && driveResult ? Date.now() - tBlobDone : 0;
      const sizeMB = (fullAudioBuffer.length / (1024 * 1024)).toFixed(2);
      // Stima durata audio: ~150 parole/min in italiano = ~900 caratteri/min
      const estimatedMinutes = (script.length / 900).toFixed(1);

      // Costruisci output multi-sezione
      let outputText = `🎙️ Podcast generato!\n\n`;
      outputText += `🔗 URL temporaneo (Vercel Blob, cleanup 24h):\n${blobUrl}\n\n`;

      if (upload_to_drive) {
        if (driveResult) {
          outputText += `✅ COPIA PERMANENTE su Google Drive:\n📁 ${driveResult.name}\n🔗 ${driveResult.webViewLink}\n📂 File ID: ${driveResult.fileId}\n\n`;
        } else if (driveError) {
          outputText += `⚠️ Upload Drive non riuscito:\n${driveError}\n\n`;
        }
      }

      outputText += `📊 Dettagli:\n• Titolo: ${episode_title || "(senza titolo)"}\n• Voce: ${voice}\n• Modello: ${model}\n• Velocità: ${speed}x`;
      if (instructions) outputText += `\n• Tono: ${instructions}`;
      outputText += `\n• Caratteri script: ${script.length.toLocaleString("it-IT")}\n• Chunk generati: ${chunks.length} (in parallelo)\n• Dimensione MP3: ${sizeMB} MB\n• Durata audio stimata: ~${estimatedMinutes} minuti\n• Tempo generazione TTS+Blob: ${(blobMs / 1000).toFixed(1)}s`;
      if (driveMs > 0) outputText += `\n• Tempo upload Drive: ${(driveMs / 1000).toFixed(1)}s`;
      outputText += `\n• Tempo totale: ${(durationMs / 1000).toFixed(1)}s\n\n`;

      outputText += `⚠️ Policy OpenAI: quando condividi questo podcast, dichiara agli ascoltatori che la voce è AI-generated.`;

      if (!upload_to_drive) {
        outputText += `\n\n💡 Vuoi conservarlo? Aggiungi upload_to_drive=true al prossimo episodio per salvarlo automaticamente sul tuo Google Drive (cartella "Audio e Podcast"). Altrimenti scaricalo dal link sopra entro 24h.`;
      }

      return {
        content: [{ type: "text", text: outputText }]
      };

    } catch (err) {
      // Diagnosi automatica del tipo di errore
      let diagnosis = "Errore non identificato. Controlla i log Vercel per dettagli.";
      const msg = err.message || "";
      if (msg.includes("timeout") || msg.includes("TIMEOUT") || msg.includes("FUNCTION_INVOCATION_TIMEOUT")) {
        diagnosis = "Timeout Vercel (Hobby: 10s, Pro: 60s, Pro+maxDuration: 300s). Soluzione: spezza lo script in più episodi più corti.";
      } else if (msg.includes("rate") || msg.includes("429")) {
        diagnosis = "Rate limit OpenAI raggiunto. Aspetta un minuto e riprova.";
      } else if (msg.includes("quota") || msg.includes("insufficient")) {
        diagnosis = "Quota OpenAI esaurita. Verifica platform.openai.com/usage.";
      } else if (msg.includes("401")) {
        diagnosis = "OPENAI_API_KEY non valida. Verifica le env var su Vercel.";
      } else if (msg.includes("invalid_grant") || msg.includes("unauthorized_client")) {
        diagnosis = "Google OAuth scaduto o non valido. Verifica GOOGLE_REFRESH_TOKEN su Vercel o testa con google_test_auth.";
      }

      return {
        content: [{ type: "text", text: `❌ Errore generazione podcast: ${msg}\n\n🔍 Diagnosi: ${diagnosis}\n\nCose da provare:\n• Verifica OPENAI_API_KEY su Vercel\n• Per script lunghi usa modello gpt-4o-mini-tts (chunk più grandi)\n• Riduci la lunghezza dello script o spezzalo in più episodi\n• Se è un errore Drive: lancia google_test_auth per diagnosticare\n• Controlla i log della function su Vercel dashboard` }],
        isError: true,
      };
    }
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
    return { content: [{ type: "text", text: `🎬 Video in generazione!\nVideo ID: ${d.data.video_id}\nUsa heygen_check_status per monitorare.` }] };
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
    const text = videoData.video_url ? `✅ Pronto!\nURL: ${videoData.video_url}` : `⏳ Stato: ${videoData.status}`;
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
    return { content: [{ type: "text", text: `🎵 Musica in generazione!\nTask ID: ${d.id}\nUsa suno_check_status per il risultato.` }] };
  });

  server.registerTool("suno_check_status", {
    title: "Suno - Controlla Stato",
    description: "Controlla lo stato di un task Suno.",
    inputSchema: { task_id: z.string().describe("ID del task") },
  }, async ({ task_id }) => {
    const r = await fetch(`https://api.acedata.cloud/suno/audios/${task_id}`, { headers: { "Authorization": `Bearer ${KEYS.suno}` } });
    if (!r.ok) throw new Error(`Suno error: ${await r.text()}`);
    const d = await r.json();
    const text = d.audio_url ? `✅ Pronto!\nURL: ${d.audio_url}` : `⏳ Stato: ${d.status}`;
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
    return { content: [{ type: "text", text: `🎬 Video in generazione!\nJob ID: ${d.job_id}\nUsa higgsfield_check_status per monitorare.` }] };
  });

  server.registerTool("higgsfield_check_status", {
    title: "Higgsfield - Controlla Stato",
    description: "Controlla lo stato di un job Higgsfield.",
    inputSchema: { job_id: z.string().describe("ID del job") },
  }, async ({ job_id }) => {
    const r = await fetch(`https://api.higgsfield.ai/v1/video/status/${job_id}`, { headers: { "Authorization": `Bearer ${KEYS.higgsfield}` } });
    if (!r.ok) throw new Error(`Higgsfield error: ${await r.text()}`);
    const d = await r.json();
    const text = d.video_url ? `✅ Pronto!\nURL: ${d.video_url}` : `⏳ Stato: ${d.status}`;
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
      merge_intensity: z.number().default(0.8).describe("Intensità mix (0-1)"),
    },
  }, async ({ input_video, input_audio, override_audio, merge_intensity }) => {
    const r = await fetch("https://api.segmind.com/v1/video-audio-merge", {
      method: "POST",
      headers: { "x-api-key": KEYS.segmind, "Content-Type": "application/json" },
      body: JSON.stringify({ input_video, input_audio, video_start: 0, video_end: -1, audio_start: 0, audio_end: -1, audio_fade_in: 0, audio_fade_out: 0, override_audio, merge_intensity }),
    });
    if (!r.ok) throw new Error(`Segmind error: ${await r.text()}`);
    const d = await r.json();
    return { content: [{ type: "text", text: `✅ Video+Audio merged!\nURL: ${d.output_url || d.url || d.output || JSON.stringify(d)}` }] };
  });

  server.registerTool("segmind_multi_video_merge", {
    title: "Segmind - Multi Video Merge",
    description: "Unisce più video clip in sequenza.",
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
    return { content: [{ type: "text", text: `✅ ${video_urls.length} video merged!\nURL: ${d.output_url || d.url || d.output || JSON.stringify(d)}` }] };
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

  server.registerTool("gmail_download_attachment", {
    title: "Gmail - Scarica Allegato",
    description: "Scarica un allegato specifico da un'email Gmail, lo carica su Vercel Blob (store pubblico con cleanup automatico dopo 24h), e restituisce un URL pubblico fetchabile. Claude può poi usare web_fetch su questo URL per leggere il contenuto del file (PDF, immagini, Excel, ecc.).",
    inputSchema: {
      message_id: z.string().describe("ID del messaggio Gmail"),
      attachment_id: z.string().describe("ID dell'allegato (da gmail_list_attachments)"),
      filename: z.string().describe("Nome file originale (usato per l'URL pubblico)"),
    },
  }, async ({ message_id, attachment_id, filename }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: message_id,
        id: attachment_id,
      });
      if (!att.data.data) throw new Error("Nessun dato ricevuto da Gmail per questo allegato");
      const buffer = base64urlToBuffer(att.data.data);
      const url = await uploadBufferToBlob(buffer, filename, "gmail-attachments");
      return { content: [{ type: "text", text: `✅ Allegato scaricato\n\n📄 File: ${filename}\n📊 Dimensione: ${(buffer.length / 1024).toFixed(1)} KB\n🔗 URL: ${url}\n\nUsa web_fetch su questo URL per leggere il contenuto.\n\n⚠️ Il file sarà automaticamente eliminato entro 24h dal cron job di cleanup.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail download error: ${err.message}` }], isError: true };
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


  server.registerTool("gmail_send_with_attachments", {
    title: "Gmail - Invia Email con Allegati",
    description: "Invia un'email dal tuo account Gmail con uno o più allegati. Ogni allegato va fornito con filename e content_base64 (contenuto del file codificato in base64) oppure url (URL pubblico da cui il server scaricherà il file). Supporta destinatari multipli, CC, BCC, e corpo testo o HTML. Limite totale del messaggio ~25 MB (Gmail API).",
    inputSchema: {
      to: z.string().describe("Destinatario/i, separati da virgola se multipli"),
      subject: z.string().describe("Oggetto dell'email"),
      body: z.string().describe("Corpo dell'email (testo o HTML)"),
      cc: z.string().optional().describe("CC (opzionale, separati da virgola)"),
      bcc: z.string().optional().describe("BCC (opzionale, separati da virgola)"),
      is_html: z.boolean().default(false).describe("True se body è HTML, false per testo"),
      attachments: z.array(z.object({
        filename: z.string().describe("Nome del file come apparirà nell'email"),
        mime_type: z.string().optional().describe("MIME type (default application/octet-stream). Es: application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        content_base64: z.string().optional().describe("Contenuto del file codificato in base64 (standard, non base64url)"),
        url: z.string().optional().describe("URL pubblico da cui il server scaricherà il file se content_base64 non è fornito"),
      })).min(1).describe("Array di allegati (almeno 1). Ognuno deve avere filename e content_base64 OPPURE url."),
    },
  }, async ({ to, subject, body, cc, bcc, is_html, attachments }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });

      // Risolvi il contenuto di ciascun allegato (base64 inline o fetch da URL)
      const resolved = [];
      for (const att of attachments) {
        let buffer;
        if (att.content_base64) {
          buffer = Buffer.from(att.content_base64, "base64");
        } else if (att.url) {
          const resp = await fetch(att.url);
          if (!resp.ok) throw new Error(`Impossibile scaricare allegato "${att.filename}" da ${att.url}: HTTP ${resp.status}`);
          const arr = await resp.arrayBuffer();
          buffer = Buffer.from(arr);
        } else {
          throw new Error(`Allegato "${att.filename}" senza content_base64 né url`);
        }
        resolved.push({
          filename: att.filename,
          mimeType: att.mime_type || "application/octet-stream",
          buffer,
        });
      }

      // Costruzione messaggio MIME multipart/mixed
      const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
      const bodyContentType = is_html ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";

      const headers = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        bcc ? `Bcc: ${bcc}` : null,
        `Subject: ${subjectEncoded}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ].filter(Boolean).join("\r\n");

      const parts = [];
      // Parte corpo
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: ${bodyContentType}\r\n` +
        `Content-Transfer-Encoding: 7bit\r\n\r\n` +
        `${body}\r\n`
      );
      // Parti allegati
      for (const att of resolved) {
        const b64 = att.buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
        const filenameEncoded = `=?UTF-8?B?${Buffer.from(att.filename).toString("base64")}?=`;
        parts.push(
          `--${boundary}\r\n` +
          `Content-Type: ${att.mimeType}; name="${filenameEncoded}"\r\n` +
          `Content-Disposition: attachment; filename="${filenameEncoded}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n\r\n` +
          `${b64}\r\n`
        );
      }
      parts.push(`--${boundary}--`);

      const rawMessage = `${headers}\r\n\r\n${parts.join("")}`;
      const encodedMessage = Buffer.from(rawMessage).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      const result = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encodedMessage },
      });

      const totalBytes = resolved.reduce((s, a) => s + a.buffer.length, 0);
      const attSummary = resolved
        .map(a => `  • ${a.filename} (${(a.buffer.length / 1024).toFixed(1)} KB, ${a.mimeType})`)
        .join("\n");
      return {
        content: [{
          type: "text",
          text: `✅ Email inviata con ${resolved.length} allegato/i\nMessage ID: ${result.data.id}\nA: ${to}${cc ? `\nCC: ${cc}` : ""}${bcc ? `\nBCC: ${bcc}` : ""}\nOggetto: ${subject}\nDimensione totale allegati: ${(totalBytes / 1024).toFixed(1)} KB\n\nAllegati:\n${attSummary}`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail send-with-attachments error: ${err.message}` }], isError: true };
    }
  });



  // ----- GMAIL — READ / SEARCH -----
  server.registerTool("gmail_search_messages", {
    title: "Gmail - Cerca Messaggi",
    description: "Cerca email con sintassi query Gmail (es. 'from:user@example.com subject:fattura after:2025/01/01 has:attachment'). Restituisce una lista con messageId, mittente, destinatari, oggetto, data e snippet. Usa gmail_get_message con il messageId per leggere il contenuto completo.",
    inputSchema: {
      query: z.string().describe("Query in sintassi Gmail. Esempi: 'from:pippo@ex.com', 'is:unread', 'has:attachment', 'subject:fattura', 'after:2025/01/01', 'label:inbox'."),
      max_results: z.number().int().min(1).max(100).default(20).describe("Numero massimo di risultati (1-100, default 20)"),
    },
  }, async ({ query, max_results }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: max_results });
      const messages = list.data.messages || [];
      if (messages.length === 0) {
        return { content: [{ type: "text", text: `Nessun messaggio trovato per query: "${query}"` }] };
      }
      const details = [];
      for (const m of messages) {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
        });
        const headers = msg.data.payload?.headers || [];
        details.push({
          messageId: msg.data.id,
          threadId: msg.data.threadId,
          from: gmailGetHeader(headers, "From"),
          to: gmailGetHeader(headers, "To"),
          cc: gmailGetHeader(headers, "Cc"),
          subject: gmailGetHeader(headers, "Subject"),
          date: gmailGetHeader(headers, "Date"),
          snippet: msg.data.snippet || "",
          labels: msg.data.labelIds || [],
        });
      }
      const summary = details.map((d, i) =>
        `${i + 1}. messageId=${d.messageId}\n   From: ${d.from}\n   To: ${d.to}${d.cc ? `\n   Cc: ${d.cc}` : ""}\n   Subject: ${d.subject}\n   Date: ${d.date}\n   Labels: ${d.labels.join(", ")}\n   Snippet: ${d.snippet.slice(0, 220)}`
      ).join("\n\n");
      return { content: [{ type: "text", text: `📧 Trovati ${details.length} messaggi per "${query}":\n\n${summary}\n\n🔎 Usa gmail_get_message con il messageId per leggere il contenuto completo.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail search error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("gmail_get_message", {
    title: "Gmail - Leggi Messaggio",
    description: "Legge il contenuto completo di un'email Gmail dato il messageId: mittente, destinatari, oggetto, data, corpo (testo semplice o HTML) ed elenco allegati. Usa truncate_body per limitare il corpo a N caratteri.",
    inputSchema: {
      message_id: z.string().describe("ID del messaggio Gmail (da gmail_search_messages)"),
      truncate_body: z.number().int().min(100).optional().describe("Se impostato, tronca il corpo a questo numero di caratteri"),
      prefer_html: z.boolean().default(false).describe("Se true preferisce la versione HTML; altrimenti testo semplice"),
    },
  }, async ({ message_id, truncate_body, prefer_html }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const msg = await gmail.users.messages.get({ userId: "me", id: message_id, format: "full" });
      const headers = msg.data.payload?.headers || [];
      const { plain, html } = extractGmailBody(msg.data.payload);
      const attachments = extractGmailAttachments(msg.data.payload);
      let body = prefer_html ? (html || plain) : (plain || html);
      if (!body) body = msg.data.snippet || "(nessun contenuto)";
      const origLen = body.length;
      if (truncate_body && body.length > truncate_body) {
        body = body.slice(0, truncate_body) + `\n…[troncato, ${origLen - truncate_body} caratteri in più]`;
      }
      const attList = attachments.length > 0
        ? `\n\n📎 Allegati (${attachments.length}):\n` + attachments.map((a, i) =>
            `  ${i + 1}. ${a.filename} — ${(a.size / 1024).toFixed(1)} KB — ${a.mimeType}\n     attachmentId: ${a.attachmentId}`
          ).join("\n") + `\n\n💡 Usa gmail_download_attachment con message_id + attachment_id + filename per scaricarli.`
        : "";
      return { content: [{ type: "text", text: `Message ID: ${msg.data.id}\nThread ID: ${msg.data.threadId}\nLabels: ${(msg.data.labelIds || []).join(", ")}\n\nFrom: ${gmailGetHeader(headers, "From")}\nTo: ${gmailGetHeader(headers, "To")}${gmailGetHeader(headers, "Cc") ? `\nCc: ${gmailGetHeader(headers, "Cc")}` : ""}\nSubject: ${gmailGetHeader(headers, "Subject")}\nDate: ${gmailGetHeader(headers, "Date")}\n\n─── CORPO (${prefer_html ? "HTML" : "TESTO"}) ───\n\n${body}${attList}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail get message error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("gmail_list_threads", {
    title: "Gmail - Elenca Thread",
    description: "Elenca le conversazioni Gmail che corrispondono a una query. Un thread raggruppa messaggi correlati (email originale + risposte). Usa gmail_get_thread per leggere tutti i messaggi di un thread.",
    inputSchema: {
      query: z.string().default("").describe("Query in sintassi Gmail (opzionale, default tutti i thread)"),
      max_results: z.number().int().min(1).max(100).default(20).describe("Numero massimo di thread (default 20)"),
    },
  }, async ({ query, max_results }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const list = await gmail.users.threads.list({ userId: "me", q: query || undefined, maxResults: max_results });
      const threads = list.data.threads || [];
      if (threads.length === 0) {
        return { content: [{ type: "text", text: `Nessun thread trovato per "${query}"` }] };
      }
      const summary = threads.map((t, i) =>
        `${i + 1}. threadId=${t.id}\n   Snippet: ${(t.snippet || "").slice(0, 220)}`
      ).join("\n\n");
      return { content: [{ type: "text", text: `🧵 Trovati ${threads.length} thread:\n\n${summary}\n\n🔎 Usa gmail_get_thread con il threadId per leggere la conversazione completa.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail list threads error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("gmail_get_thread", {
    title: "Gmail - Leggi Thread",
    description: "Legge tutti i messaggi di una conversazione Gmail (thread) in ordine cronologico, inclusi mittente, data, oggetto e corpo di ogni messaggio.",
    inputSchema: {
      thread_id: z.string().describe("ID del thread"),
      truncate_body: z.number().int().min(100).optional().describe("Tronca il corpo di ciascun messaggio a N caratteri (opzionale)"),
      prefer_html: z.boolean().default(false),
    },
  }, async ({ thread_id, truncate_body, prefer_html }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const thr = await gmail.users.threads.get({ userId: "me", id: thread_id, format: "full" });
      const messages = thr.data.messages || [];
      if (messages.length === 0) {
        return { content: [{ type: "text", text: `Thread vuoto.` }] };
      }
      const parts = messages.map((m, i) => {
        const h = m.payload?.headers || [];
        const { plain, html } = extractGmailBody(m.payload);
        let body = prefer_html ? (html || plain) : (plain || html);
        if (!body) body = m.snippet || "";
        const origLen = body.length;
        if (truncate_body && body.length > truncate_body) {
          body = body.slice(0, truncate_body) + `\n…[troncato, ${origLen - truncate_body} caratteri in più]`;
        }
        return `### Messaggio ${i + 1} [messageId=${m.id}]\nFrom: ${gmailGetHeader(h, "From")}\nDate: ${gmailGetHeader(h, "Date")}\nSubject: ${gmailGetHeader(h, "Subject")}\n\n${body}`;
      }).join("\n\n───────────────\n\n");
      return { content: [{ type: "text", text: `🧵 Thread ID: ${thread_id}\nNumero messaggi: ${messages.length}\n\n${parts}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail get thread error: ${err.message}` }], isError: true };
    }
  });

  server.registerTool("gmail_export_message_eml", {
    title: "Gmail - Esporta Email come .eml",
    description: "Esporta un'email Gmail come file .eml (formato RFC 5322 standard con tutti gli header originali e gli allegati). Il file viene caricato su Vercel Blob e ne viene restituito un URL pubblico (cleanup automatico dopo 24h). Utile per archiviazione o import in altri client mail.",
    inputSchema: {
      message_id: z.string().describe("ID del messaggio Gmail da esportare"),
      filename: z.string().optional().describe("Nome file .eml (opzionale, default: usa oggetto email sanitizzato)"),
    },
  }, async ({ message_id, filename }) => {
    try {
      const google = await loadGoogleapis();
      const auth = await getGoogleAuth();
      const gmail = google.gmail({ version: "v1", auth });
      const msg = await gmail.users.messages.get({ userId: "me", id: message_id, format: "raw" });
      if (!msg.data.raw) throw new Error("Formato raw non disponibile");
      const buffer = base64urlToBuffer(msg.data.raw);
      let finalName = filename;
      if (!finalName) {
        const meta = await gmail.users.messages.get({ userId: "me", id: message_id, format: "metadata", metadataHeaders: ["Subject"] });
        const subject = gmailGetHeader(meta.data.payload?.headers || [], "Subject") || message_id;
        finalName = subject.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) + ".eml";
      }
      if (!finalName.toLowerCase().endsWith(".eml")) finalName += ".eml";
      const url = await uploadBufferToBlob(buffer, finalName, "gmail-exports");
      return { content: [{ type: "text", text: `✅ Email esportata come .eml\n\n📧 Message ID: ${message_id}\n📁 File: ${finalName}\n📊 Dimensione: ${(buffer.length / 1024).toFixed(1)} KB\n🔗 URL: ${url}\n\n⚠️ Il file sarà eliminato automaticamente entro 24h.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Gmail export error: ${err.message}` }], isError: true };
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

// ============================================================
// CLEANUP BLOBS — Eliminazione automatica dei file vecchi
// ============================================================
// Può essere chiamato in due modi:
//  1) POST /cleanup-blobs con header "Authorization: Bearer <CLEANUP_SECRET>"
//     (uso manuale / da altri servizi)
//  2) GET  /cleanup-blobs?secret=<CLEANUP_SECRET>
//     (usato dal Cron Job Vercel, vedi vercel.json — i cron Vercel
//     non possono passare header custom, solo query string)
//
// Elimina tutti i blob più vecchi di max_age_hours (default 24)
// nelle cartelle gmail-attachments/, drive-files/, drive-exports/, tts-podcasts/.
// ============================================================

async function runCleanup(maxAgeHours) {
  const cutoffMs = Date.now() - maxAgeHours * 3600 * 1000;
  const prefixes = ["gmail-attachments/", "gmail-exports/", "drive-files/", "drive-exports/", "tts-podcasts/"];

  const summary = {
    started_at: new Date().toISOString(),
    max_age_hours: maxAgeHours,
    cutoff: new Date(cutoffMs).toISOString(),
    deleted: [],
    errors: [],
    total_scanned: 0,
    total_deleted: 0,
  };

  const { list, del } = await loadBlob();

  for (const prefix of prefixes) {
    let cursor = undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        summary.total_scanned += 1;
        const uploadedAt = new Date(blob.uploadedAt).getTime();
        if (uploadedAt < cutoffMs) {
          try {
            await del(blob.url);
            summary.deleted.push({ pathname: blob.pathname, uploadedAt: blob.uploadedAt });
            summary.total_deleted += 1;
          } catch (e) {
            summary.errors.push({ pathname: blob.pathname, error: e.message });
          }
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

// POST /cleanup-blobs — uso manuale con header Bearer
app.post("/cleanup-blobs", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const expectedSecret = process.env.CLEANUP_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ error: "CLEANUP_SECRET non configurato sulle env var" });
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const maxAgeHours = Number(req.body?.max_age_hours ?? 24);
  try {
    const summary = await runCleanup(maxAgeHours);
    return res.json(summary);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /cleanup-blobs?secret=... — usato dal Cron Vercel
app.get("/cleanup-blobs", async (req, res) => {
  const expectedSecret = process.env.CLEANUP_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ error: "CLEANUP_SECRET non configurato sulle env var" });
  }
  const providedSecret = req.query?.secret || "";
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const maxAgeHours = Number(req.query?.max_age_hours ?? 24);
  try {
    const summary = await runCleanup(maxAgeHours);
    return res.json(summary);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Paolo AI MCP Server su porta ${PORT}`));
