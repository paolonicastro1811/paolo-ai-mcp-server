import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerSegmindTools(server: McpServer) {
  // Tool 1: Video + Audio Merge
  server.tool(
    "segmind_video_audio_merge",
    "Unisce un file video con un file audio (voiceover o musica). Perfetto per aggiungere voiceover o musica di sottofondo a un video.",
    {
      input_video: z.string().describe("URL del video da usare come base"),
      input_audio: z.string().describe("URL dell'audio da sovrapporre (voiceover o musica)"),
      override_audio: z.boolean().default(true).describe("Se true, sostituisce l'audio originale. Se false, mixa i due audio."),
      merge_intensity: z.number().default(0.8).describe("Intensità del mix audio (0.0 a 1.0)"),
      audio_fade_in: z.number().default(0).describe("Durata fade-in audio in secondi"),
      audio_fade_out: z.number().default(0).describe("Durata fade-out audio in secondi"),
    },
    async ({ input_video, input_audio, override_audio, merge_intensity, audio_fade_in, audio_fade_out }) => {
      try {
        const response = await fetch("https://api.segmind.com/v1/video-audio-merge", {
          method: "POST",
          headers: {
            "x-api-key": process.env.SEGMIND_API_KEY || "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input_video,
            input_audio,
            video_start: 0,
            video_end: -1,
            audio_start: 0,
            audio_end: -1,
            audio_fade_in,
            audio_fade_out,
            override_audio,
            merge_intensity,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { content: [{ type: "text" as const, text: `Segmind error (${response.status}): ${errorText}` }] };
        }

        const contentType = response.headers.get("content-type");

        if (contentType && contentType.includes("application/json")) {
          const result = await response.json();
          const url = result.output_url || result.url || result.output || JSON.stringify(result);
          return { content: [{ type: "text" as const, text: `✅ Video + Audio merged!\nURL: ${url}` }] };
        } else {
          const buffer = await response.arrayBuffer();
          const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
          return { content: [{ type: "text" as const, text: `✅ Video + Audio merged! (${sizeMB}MB, formato: ${contentType})` }] };
        }
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: `Segmind merge error: ${error.message}` }] };
      }
    }
  );

  // Tool 2: Multi Video Merge
  server.tool(
    "segmind_multi_video_merge",
    "Unisce più video clip in sequenza per creare un video lungo. Supporta transizioni fade tra le clip.",
    {
      video_urls: z.array(z.string()).describe("Array di URL dei video da unire in sequenza (min 2, max 10)"),
      width: z.number().default(1080).describe("Larghezza output in pixel"),
      height: z.number().default(1920).describe("Altezza output in pixel"),
      fps: z.number().default(30).describe("Frame rate output"),
      transition_type: z.string().default("fade").describe("Tipo transizione: concat, fade, none"),
      transition_duration: z.number().default(0.5).describe("Durata transizione in secondi"),
      audio_handling: z.string().default("merge").describe("Audio: merge, first, none"),
    },
    async ({ video_urls, width, height, fps, transition_type, transition_duration, audio_handling }) => {
      try {
        const response = await fetch("https://api.segmind.com/v1/multi-video-merge", {
          method: "POST",
          headers: {
            "x-api-key": process.env.SEGMIND_API_KEY || "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            video_urls,
            width,
            height,
            fps,
            transition_type,
            transition_duration,
            maintain_aspect_ratio: true,
            audio_handling,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { content: [{ type: "text" as const, text: `Segmind error (${response.status}): ${errorText}` }] };
        }

        const contentType = response.headers.get("content-type");

        if (contentType && contentType.includes("application/json")) {
          const result = await response.json();
          const url = result.output_url || result.url || result.output || JSON.stringify(result);
          return { content: [{ type: "text" as const, text: `✅ ${video_urls.length} video merged!\nURL: ${url}` }] };
        } else {
          const buffer = await response.arrayBuffer();
          const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
          return { content: [{ type: "text" as const, text: `✅ ${video_urls.length} video merged! (${sizeMB}MB, formato: ${contentType})` }] };
        }
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: `Segmind multi-merge error: ${error.message}` }] };
      }
    }
  );
}
