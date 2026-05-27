/**
 * geminiService.ts
 * All Gemini calls go through the "gemini-chat" Supabase Edge Function.
 * No API key is present in this file or in the browser bundle.
 */

import { ChatMessage } from "../types";
import { audioService } from "./audioService";
import { supabase } from "./supabaseClient";

// Wraps raw PCM bytes from Gemini TTS in a WAV header so decodeAudioData can handle it
function pcmToWav(pcmData: ArrayBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): ArrayBuffer {
  const byteRate   = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize   = pcmData.byteLength;
  const buffer     = new ArrayBuffer(44 + dataSize);
  const view       = new DataView(buffer);
  const write      = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4,  36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16,           true); // chunk size
  view.setUint16(20, 1,            true); // PCM
  view.setUint16(22, numChannels,  true);
  view.setUint32(24, sampleRate,   true);
  view.setUint32(28, byteRate,     true);
  view.setUint16(32, blockAlign,   true);
  view.setUint16(34, bitsPerSample,true);
  write(36, 'data');
  view.setUint32(40, dataSize,     true);
  new Uint8Array(buffer).set(new Uint8Array(pcmData), 44);
  return buffer;
}

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
            // Decode raw LINEAR16 PCM (24 kHz mono) directly into an AudioBuffer.
            // Bypasses decodeAudioData which rejects headerless PCM on some browsers.
            const pcm16 = new Int16Array(bytes.buffer);
            audioBuffer = audioService.context.createBuffer(1, pcm16.length, 24000);
            const channel = audioBuffer.getChannelData(0);
            for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 32768.0;
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
