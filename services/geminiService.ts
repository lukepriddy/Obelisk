/**
 * geminiService.ts
 * All Gemini calls go through the "gemini-chat" Supabase Edge Function.
 * No API key is present in this file or in the browser bundle.
 */

import { ChatMessage } from "../types";
import { audioService } from "./audioService";
import { supabase } from "./supabaseClient";

class GeminiService {

  async generateCharacterResponse(
    history: ChatMessage[],
    prompt: string,
    systemInstruction: string,
    voiceStyle: string,
  ): Promise<{ text: string; audioBuffer?: AudioBuffer }> {

    try {
      // ── Step 1: text generation ─────────────────────────────────────────────
      const { data: chatData, error: chatError } = await supabase.functions.invoke(
        'gemini-chat',
        { body: { type: 'chat', history, userMessage: prompt, systemInstruction } }
      );

      if (chatError) throw chatError;

      const aiText: string = chatData?.text || "I didn't catch that.";

      // ── Step 2: TTS ─────────────────────────────────────────────────────────
      let audioBuffer: AudioBuffer | undefined;

      if (aiText.trim().length > 0 && audioService.context) {
        try {
          const { data: ttsData, error: ttsError } = await supabase.functions.invoke(
            'gemini-chat',
            { body: { type: 'tts', textToSpeak: aiText, voiceStyle: voiceStyle || 'Kore' } }
          );

          if (!ttsError && ttsData?.audioData) {
            const binary = atob(ttsData.audioData);
            const bytes  = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            audioBuffer = await audioService.context.decodeAudioData(bytes.buffer);
          }
        } catch (ttsErr) {
          // Non-fatal — user still gets the text response
          console.warn('TTS failed, continuing without audio:', ttsErr);
        }
      }

      return { text: aiText, audioBuffer };

    } catch (e: any) {
      console.error('Gemini error:', e);
      const msg = e?.message ?? String(e);
      if (msg.includes('404') || msg.includes('NOT_FOUND')) {
        return { text: 'Error: The AI model is currently unavailable.' };
      }
      return { text: `Error connecting to AI: ${msg}` };
    }
  }

  playAudio(buffer: AudioBuffer) {
    audioService.playBuffer(buffer);
  }
}

export const geminiService = new GeminiService();
