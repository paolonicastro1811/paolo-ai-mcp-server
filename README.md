# Paolo AI MCP Server

Server MCP remoto per Claude.ai che integra 6 servizi AI:
- **ElevenLabs** — Text to Speech, voci AI
- **Higgsfield** — Generazione video AI
- **Perplexity** — Ricerca AI con fonti
- **Suno** — Generazione musica AI
- **HeyGen** — Video avatar AI
- **OpenAI** — GPT chat + DALL-E immagini

---

## Deploy su Vercel

### 1. Carica su GitHub

```bash
git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/TUO_USERNAME/paolo-ai-mcp-server.git
git push -u origin main
```

### 2. Deploy su Vercel

1. Vai su [vercel.com](https://vercel.com) → **New Project**
2. Importa il repo da GitHub
3. **Build Command**: `npm run build`
4. **Output Directory**: `dist`
5. Clicca **Deploy**

### 3. Aggiungi le variabili d'ambiente

In Vercel → Settings → Environment Variables, aggiungi:

| Nome | Valore |
|------|--------|
| `ELEVENLABS_API_KEY` | la tua chiave ElevenLabs |
| `HIGGSFIELD_API_KEY` | la tua chiave Higgsfield |
| `PERPLEXITY_API_KEY` | la tua chiave Perplexity |
| `SUNO_API_KEY` | la tua chiave Suno |
| `HEYGEN_API_KEY` | la tua chiave HeyGen |
| `OPENAI_API_KEY` | la tua chiave OpenAI |

Dopo aver aggiunto le variabili, fai **Redeploy**.

### 4. Collega a Claude.ai

1. Vai su [claude.ai](https://claude.ai) → Settings → Connectors
2. Aggiungi connettore personalizzato
3. URL: `https://NOME-PROGETTO.vercel.app/mcp`
4. Salva

---

## Tool disponibili (15 totali)

### ElevenLabs
- `elevenlabs_list_voices` — lista voci disponibili
- `elevenlabs_text_to_speech` — converti testo in audio
- `elevenlabs_list_models` — lista modelli

### Higgsfield
- `higgsfield_generate_video` — genera video da prompt
- `higgsfield_check_status` — controlla stato job

### Perplexity
- `perplexity_search` — ricerca AI con fonti citate

### Suno
- `suno_generate_music` — genera musica/canzone
- `suno_check_status` — controlla stato task

### HeyGen
- `heygen_list_avatars` — lista avatar disponibili
- `heygen_list_voices` — lista voci disponibili
- `heygen_generate_video` — genera video avatar
- `heygen_check_status` — controlla stato video

### OpenAI
- `openai_chat` — chat con GPT-4o
- `openai_generate_image` — genera immagine DALL-E 3
- `openai_list_models` — lista modelli disponibili

---

## Test locale

```bash
npm install
npm run build
npm start
# Server su http://localhost:3000
# Health check: GET http://localhost:3000/
# MCP endpoint: POST http://localhost:3000/mcp
```

