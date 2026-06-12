/**
 * geminiService.ts
 * All Gemini calls go through the "gemini-chat" Supabase Edge Function.
 * No API key is present in this file or in the browser bundle.
 */

import { ChatMessage } from "../types";
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

  /**
   * Text-only character reply. Fast — used to show the message immediately,
   * before (and independently of) the slower TTS step.
   * tourId lets the edge function charge the tour owner's Gemini key (BYOK).
   */
  async generateText(
    history: ChatMessage[],
    prompt: string,
    systemInstruction: string,
    tourId?: string,
  ): Promise<string> {
    const { data, error } = await supabase.functions.invoke(
      'gemini-chat',
      { body: { type: 'chat', history, userMessage: prompt, systemInstruction, tourId } }
    );
    if (error) throw error;
    return data?.text || "I didn't catch that.";
  }

  /**
   * TTS only — returns a playable WAV object URL, or undefined on any failure
   * (audio is always optional; the text response stands alone).
   *
   * We wrap the raw PCM in a WAV header and hand back a blob URL for playback
   * via an HTMLAudioElement — the SAME path zone audio uses, which is reliably
   * unlocked on iOS/Safari. (Web Audio's AudioContext path was unreliable for
   * these async-loaded buffers on mobile.)
   */
  async speak(text: string, voiceStyle: string, tourId?: string): Promise<string | undefined> {
    if (!text.trim()) return undefined;

    try {
      const { data: ttsData, error: ttsError } = await supabase.functions.invoke(
        'gemini-chat',
        { body: { type: 'tts', textToSpeak: text, voiceStyle: voiceStyle || 'Kore', tourId } }
      );
      if (ttsError || !ttsData?.audioData) return undefined;

      const binary = atob(ttsData.audioData);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // Gemini TTS returns headerless LINEAR16 PCM (24 kHz mono). Wrap it in a
      // WAV header so a plain <audio> element can decode and play it.
      const wav = pcmToWav(bytes.buffer);
      const blob = new Blob([wav], { type: 'audio/wav' });
      return URL.createObjectURL(blob);
    } catch (ttsErr) {
      console.warn('TTS failed, continuing without audio:', ttsErr);
      return undefined;
    }
  }
}

export const geminiService = new GeminiService();
