import React, { useState, useEffect, useRef } from 'react';
import { Zone, ChatMessage } from '../types';
import { GoogleGenAI, Modality } from '@google/genai';
import { Mic, X, Send, Square } from 'lucide-react';

interface ChatInterfaceProps {
  zone: Zone;
  onClose: () => void;
  onUnlock?: (zoneId: string) => void;
}

const API_KEY = (import.meta as any).env?.VITE_GEMINI_API_KEY || '';

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ zone, onClose, onUnlock }) => {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recognitionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sourceFlagsRef = useRef<WeakMap<AudioBufferSourceNode, { interrupted: boolean }>>(new WeakMap());
  const pendingModelTextRef = useRef<string>('');

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, isSpeaking]);

  const setupSpeechRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (e: any) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          final += e.results[i][0].transcript;
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      setInputText(final || interim);
    };

    recognition.onend = () => setIsRecording(false);
    recognition.onerror = () => setIsRecording(false);

    recognitionRef.current = recognition;
  };

  const toggleMic = async () => {
    if (!recognitionRef.current) {
      setupSpeechRecognition();
      if (!recognitionRef.current) return;
    }
    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        recognitionRef.current.start();
        setIsRecording(true);
      } catch {
        setErrorMsg('Microphone access denied. Please allow mic access and try again.');
      }
    }
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text) return;

    if (!sessionRef.current) {
      setErrorMsg('Still connecting — please wait a moment.');
      return;
    }

    setHistory(prev => [...prev, { role: 'user', text }]);
    setInputText('');

    try {
      const session = await sessionRef.current;
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.error('Failed to send message', e);
    }
  };

  const connect = async () => {
    console.log('[Chat] connect() called, API_KEY present:', !!API_KEY);
    if (!API_KEY) {
      setErrorMsg('Gemini API Key missing. Add VITE_GEMINI_API_KEY to .env.local');
      return;
    }

    setIsConnecting(true);
    setErrorMsg(null);
    pendingModelTextRef.current = '';

    const timeoutId = setTimeout(() => {
      console.warn('[Chat] Connection timed out after 15s');
      setIsConnecting(false);
      setErrorMsg('Connection timed out. Check that your API key has Gemini Live API access enabled in Google AI Studio.');
      disconnect(false);
    }, 15000);

    try {
      const ai = new GoogleGenAI({ apiKey: API_KEY });
      console.log('[Chat] GoogleGenAI created, calling ai.live.connect...');

      // Close any leftover AudioContext from a previous (stale) attempt before creating a new one
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      nextPlayTimeRef.current = audioContext.currentTime;

      setupSpeechRecognition();

      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onopen: () => {
            // Guard: if a newer connection has taken over, bail out.
            // disconnect() already scheduled .close() on this promise during cleanup — don't do it again.
            if (sessionRef.current !== sessionPromise) {
              clearTimeout(timeoutId); // kill this connection's ghost timeout
              return;
            }
            console.log('[Chat] onopen fired — connection established');
            clearTimeout(timeoutId);
            setIsConnected(true);
            setIsConnecting(false);
            // Use sessionPromise directly (not sessionRef.current) to avoid null-ref race
            sessionPromise.then((session: any) => {
              if (sessionRef.current !== sessionPromise) return; // stale check after await
              const greetingInstruction = zone.greeting_message
                ? `[The player has arrived. Your exact opening line is: "${zone.greeting_message}" — say it now, word for word, then wait for the player to respond.]`
                : '[The player has arrived at your location. Greet them briefly and in character, then wait for them to respond.]';
              session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: greetingInstruction }] }],
                turnComplete: true,
              });
            }).catch((e: any) => {
              console.error('[Chat] Greeting failed:', e);
            });
          },

          onmessage: async (message: any) => {
            // Ignore messages from stale connections
            if (sessionRef.current !== sessionPromise) return;
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(src => {
                const flags = sourceFlagsRef.current.get(src);
                if (flags) flags.interrupted = true;
                try { src.stop(); } catch {}
              });
              sourcesRef.current.clear();
              nextPlayTimeRef.current = audioContextRef.current?.currentTime || 0;
              pendingModelTextRef.current = '';
              setIsSpeaking(false);
            }

            const text = message.serverContent?.modelTurn?.parts?.find((p: any) => p.text)?.text;
            if (text) pendingModelTextRef.current += text;

            const transcriptionChunk = message.serverContent?.outputTranscription?.text;
            const transcriptionDone = message.serverContent?.outputTranscription?.finished;
            if (transcriptionChunk) pendingModelTextRef.current += transcriptionChunk;
            if (transcriptionDone && pendingModelTextRef.current) {
              const t = pendingModelTextRef.current;
              pendingModelTextRef.current = '';
              setHistory(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'model') return [...prev.slice(0, -1), { ...last, text: last.text + t }];
                return [...prev, { role: 'model', text: t }];
              });
            }

            const base64Audio = message.serverContent?.modelTurn?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
            if (base64Audio && audioContextRef.current) {
              setIsSpeaking(true);
              const binaryString = atob(base64Audio);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

              const pcm16 = new Int16Array(bytes.buffer);
              const audioBuffer = audioContextRef.current.createBuffer(1, pcm16.length, 24000);
              const channelData = audioBuffer.getChannelData(0);
              for (let i = 0; i < pcm16.length; i++) channelData[i] = pcm16[i] / 32768.0;

              const textForThisAudio = pendingModelTextRef.current;
              pendingModelTextRef.current = '';

              const playSource = audioContextRef.current.createBufferSource();
              playSource.buffer = audioBuffer;
              playSource.connect(audioContextRef.current.destination);
              sourcesRef.current.add(playSource);
              sourceFlagsRef.current.set(playSource, { interrupted: false });

              const startTime = Math.max(audioContextRef.current.currentTime, nextPlayTimeRef.current);
              playSource.start(startTime);
              nextPlayTimeRef.current = startTime + audioBuffer.duration;

              playSource.onended = () => {
                sourcesRef.current.delete(playSource);
                const flags = sourceFlagsRef.current.get(playSource);
                if (!flags?.interrupted && textForThisAudio) {
                  setHistory(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role === 'model') {
                      return [...prev.slice(0, -1), { ...last, text: last.text + textForThisAudio }];
                    }
                    return [...prev, { role: 'model', text: textForThisAudio }];
                  });
                }
                if (sourcesRef.current.size === 0) {
                  setIsSpeaking(false);
                  const finalText = pendingModelTextRef.current;
                  pendingModelTextRef.current = '';
                  if (finalText && !flags?.interrupted) {
                    setHistory(prev => {
                      const last = prev[prev.length - 1];
                      if (last?.role === 'model') return [...prev.slice(0, -1), { ...last, text: last.text + finalText }];
                      return [...prev, { role: 'model', text: finalText }];
                    });
                  }
                }
              };
            } else if (text && sourcesRef.current.size === 0) {
              const t = pendingModelTextRef.current;
              pendingModelTextRef.current = '';
              if (t) {
                setHistory(prev => {
                  const last = prev[prev.length - 1];
                  if (last?.role === 'model') return [...prev.slice(0, -1), { ...last, text: last.text + t }];
                  return [...prev, { role: 'model', text: t }];
                });
              }
            }
          },

          onerror: (e: any) => {
            if (sessionRef.current !== sessionPromise) return;
            clearTimeout(timeoutId);
            console.error('[Chat] onerror fired:', e);
            setErrorMsg(`Connection failed: ${e?.message || 'Check your API key and network.'}`);
            disconnect(false);
          },
          onclose: (e: any) => {
            if (sessionRef.current !== sessionPromise) return;
            console.warn('[Chat] onclose fired:', e);
            // Code 1000 = clean close (we called disconnect). Anything else = unexpected drop.
            if (e?.code !== 1000) {
              setErrorMsg(`Connection dropped by server (code ${e?.code ?? '?'}). This may be a temporary issue — close and try again.`);
            }
            disconnect(false);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: zone.voice_style || 'Kore' } },
          },
          systemInstruction: zone.character_prompt || 'You are a helpful assistant.',
        },
      });

      // Surface any connection/auth errors that the Promise rejects with
      sessionPromise.catch((err: any) => {
        clearTimeout(timeoutId);
        console.error('Session promise rejected:', err);
        setErrorMsg(`Session failed: ${err?.message || String(err)}`);
        setIsConnecting(false);
        sessionRef.current = null;
      });

      sessionRef.current = sessionPromise;
      console.log('[Chat] sessionPromise assigned to ref — waiting for onopen...');
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error('[Chat] connect() threw synchronously:', err);
      setErrorMsg(err.message || 'Failed to connect.');
      setIsConnecting(false);
    }
  };

  const disconnect = (triggerUnlock = false) => {
    if (recognitionRef.current) try { recognitionRef.current.stop(); } catch {}
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
    if (sessionRef.current) sessionRef.current.then((s: any) => s.close()).catch(() => {});
    sourcesRef.current.forEach(src => { try { src.stop(); } catch {} });
    sourcesRef.current.clear();
    sessionRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setIsSpeaking(false);
    setIsRecording(false);
    if (triggerUnlock && zone.avatar_unlock_zone_id && onUnlock) {
      onUnlock(zone.avatar_unlock_zone_id);
    }
  };

  useEffect(() => {
    connect();
    return () => disconnect(false);
  }, []);

  return (
    // Mobile: full-screen. Desktop (md+): card over map, bottom-right
    <div className="
      fixed inset-0 z-[5000] flex flex-col bg-zinc-950
      md:inset-auto md:bottom-6 md:right-6 md:w-[420px] md:h-[600px]
      md:rounded-2xl md:shadow-2xl md:border md:border-zinc-800
    ">

      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 pb-3 border-b border-zinc-800 shrink-0 rounded-t-2xl"
        style={{ paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))' }}
      >
        {zone.character_image_url ? (
          <div className="relative shrink-0">
            <img src={zone.character_image_url} alt={zone.title} className="w-9 h-9 rounded-full object-cover" />
            <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-950 transition-colors ${
              isConnected ? (isSpeaking ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-400')
              : isConnecting ? 'bg-amber-400 animate-pulse'
              : 'bg-zinc-600'
            }`} />
          </div>
        ) : (
          <div className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
            isConnected ? (isSpeaking ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-400')
            : isConnecting ? 'bg-amber-400 animate-pulse'
            : 'bg-zinc-600'
          }`} />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white text-sm leading-tight truncate">{zone.title}</h3>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">
            {isSpeaking ? 'Speaking...' : isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Offline'}
          </p>
        </div>
        <button
          onClick={() => { disconnect(history.length > 0); onClose(); }}
          className="w-9 h-9 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      {/* Chat log */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 min-h-0">

        {isConnecting && (
          <div className="flex items-center justify-center gap-2 py-8 text-zinc-500">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-indigo-400 rounded-full animate-spin" />
            <span className="text-sm">Connecting to {zone.title}...</span>
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3 rounded-2xl text-center">
            {errorMsg}
          </div>
        )}

        {history.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-indigo-600 text-white rounded-br-md'
                : 'bg-zinc-800 text-zinc-100 rounded-bl-md'
            }`}>
              {msg.text}
            </div>
          </div>
        ))}

        {isSpeaking && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 px-4 py-3 rounded-2xl rounded-bl-md flex gap-1.5 items-center">
              <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: '120ms' }} />
              <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: '240ms' }} />
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div
        className="px-3 pt-2 shrink-0 border-t border-zinc-800"
        style={{ paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-end gap-2">
          <button
            onClick={toggleMic}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              isRecording
                ? 'bg-red-500 text-white'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
            }`}
          >
            {isRecording ? <Square size={15} fill="currentColor" /> : <Mic size={15} />}
          </button>

          <textarea
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-2xl px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60 resize-none leading-snug"
            placeholder={isConnecting ? 'Connecting...' : isConnected ? 'Message...' : 'Not connected'}
            value={inputText}
            rows={1}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            style={{ maxHeight: '100px' }}
          />

          <button
            onClick={sendMessage}
            disabled={!inputText.trim()}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              inputText.trim()
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                : 'bg-zinc-900 text-zinc-700 cursor-not-allowed'
            }`}
          >
            <Send size={15} />
          </button>
        </div>
        {isRecording && (
          <p className="text-[10px] text-red-400 text-center mt-1.5 animate-pulse">Listening...</p>
        )}
      </div>
    </div>
  );
};
