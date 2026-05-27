import React, { useState, useEffect, useRef } from 'react';
import { Zone, ChatMessage } from '../types';
import { geminiService } from '../services/geminiService';
import { audioService } from '../services/audioService';
import { Mic, X, Send, Square, Volume2 } from 'lucide-react';

interface ChatInterfaceProps {
  zone: Zone;
  onClose: () => void;
  onUnlock?: (zoneId: string) => void;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ zone, onClose, onUnlock }) => {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  // greetState: 'begin' = waiting for tap, 'loading' = fetching greeting, 'done' = greeted
  const [greetState, setGreetState] = useState<'begin' | 'loading' | 'done'>('begin');
  const greetingAudioRef = useRef<AudioBuffer | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const hasGreetedRef = useRef(false);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Play an AudioBuffer through the shared audio context.
  // Falls back to clearing isSpeaking after a timeout if onended never fires.
  const playAudio = async (buffer: AudioBuffer, onDone?: () => void) => {
    const ctx = audioService.context;
    if (!ctx) { setIsSpeaking(false); onDone?.(); return; }

    // Make sure the context is running (iOS requires this)
    if (ctx.state === 'suspended') await ctx.resume();

    setIsSpeaking(true);

    // Safety timeout — clear speaking state if onended never fires
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    speakingTimerRef.current = setTimeout(() => {
      setIsSpeaking(false);
      onDone?.();
    }, (buffer.duration + 3) * 1000);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    src.onended = () => {
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
      setIsSpeaking(false);
      onDone?.();
    };
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, isSpeaking]);

  // Fetch the greeting text+audio on mount (silently — no autoplay attempt)
  useEffect(() => {
    if (hasGreetedRef.current) return;
    hasGreetedRef.current = true;

    const fetchGreeting = async () => {
      const greetingPrompt = zone.greeting_message
        ? `[The player has arrived. Your exact opening line is: "${zone.greeting_message}" — say it now, word for word, then wait for the player to respond.]`
        : '[The player has arrived at your location. Greet them briefly and in character, then wait for them to respond.]';

      try {
        const { text, audioBuffer } = await geminiService.generateCharacterResponse(
          [],
          greetingPrompt,
          zone.character_prompt || 'You are a helpful assistant.',
          zone.voice_style || 'Kore',
        );
        setHistory([{ role: 'model', text }]);
        greetingAudioRef.current = audioBuffer ?? null;
        setIsReady(true);
        // Stay in 'begin' state — wait for user tap before playing audio
      } catch (e) {
        setErrorMsg('Could not reach the character. Check your connection and try again.');
        setIsReady(true);
        setGreetState('done');
      }
    };

    fetchGreeting();
  }, []);

  // Called when the user taps "Begin" — runs inside a gesture so audio is allowed
  const handleBegin = () => {
    const ctx = audioService.context;
    if (ctx) {
      // Play a silent buffer immediately to permanently unlock audio playback
      if (ctx.state === 'suspended') ctx.resume();
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = silent;
      s.connect(ctx.destination);
      s.start(0);
    }
    setGreetState('done');
    if (greetingAudioRef.current) {
      playAudio(greetingAudioRef.current);
    }
  };

  // Speech recognition setup
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
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
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
        setErrorMsg('Microphone access denied.');
      }
    }
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;

    const newHistory: ChatMessage[] = [...history, { role: 'user', text }];
    setHistory(newHistory);
    setInputText('');
    setIsSending(true);
    setErrorMsg(null);

    try {
      // Pass only the real conversation (exclude the internal greeting prompt)
      const conversationHistory = newHistory.filter(m => m.role === 'user' || m.role === 'model');

      const { text: replyText, audioBuffer } = await geminiService.generateCharacterResponse(
        conversationHistory.slice(0, -1), // history before this message
        text,
        zone.character_prompt || 'You are a helpful assistant.',
        zone.voice_style || 'Kore',
      );

      setHistory(prev => [...prev, { role: 'model', text: replyText }]);

      if (audioBuffer) {
        await playAudio(audioBuffer, () => {
          if (zone.avatar_unlock_zone_id && onUnlock) {
            onUnlock(zone.avatar_unlock_zone_id);
          }
        });
      }
    } catch (e) {
      setErrorMsg('Something went wrong. Try again.');
    } finally {
      setIsSending(false);
    }
  };

  const handleClose = () => {
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
    if (recognitionRef.current) try { recognitionRef.current.stop(); } catch {}
    onClose();
  };

  const isLoading = !isReady || isSending || greetState !== 'done';

  return (
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
              isSpeaking ? 'bg-indigo-400 animate-pulse'
              : isLoading ? 'bg-amber-400 animate-pulse'
              : 'bg-emerald-400'
            }`} />
          </div>
        ) : (
          <div className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
            isSpeaking ? 'bg-indigo-400 animate-pulse'
            : isLoading ? 'bg-amber-400 animate-pulse'
            : 'bg-emerald-400'
          }`} />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white text-sm leading-tight truncate">{zone.title}</h3>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">
            {isSpeaking ? 'Speaking...' : isSending ? 'Thinking...' : !isReady ? 'Starting...' : greetState === 'begin' ? 'Tap Begin' : 'Ready'}
          </p>
        </div>
        <button
          onClick={handleClose}
          className="w-9 h-9 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      {/* Chat log */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 min-h-0">

        {!isReady && (
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

        {/* Begin button — shown after greeting loads, before user taps to unlock audio */}
        {isReady && greetState === 'begin' && (
          <div className="flex flex-col items-center gap-2 py-4">
            <button
              onClick={handleBegin}
              className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white font-semibold rounded-full text-sm transition-all shadow-lg"
            >
              Begin
            </button>
            <p className="text-[10px] text-zinc-500">Tap to start the conversation</p>
          </div>
        )}

        {isSending && (
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
            disabled={isLoading}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              isRecording
                ? 'bg-red-500 text-white'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40'
            }`}
          >
            {isRecording ? <Square size={15} fill="currentColor" /> : <Mic size={15} />}
          </button>

          <textarea
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-2xl px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60 resize-none leading-snug disabled:opacity-40"
            placeholder={!isReady ? 'Starting...' : greetState === 'begin' ? 'Tap Begin above...' : isSending ? 'Thinking...' : 'Message...'}
            value={inputText}
            rows={1}
            disabled={isLoading}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            style={{ maxHeight: '100px' }}
          />

          <button
            onClick={sendMessage}
            disabled={!inputText.trim() || isLoading}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              inputText.trim() && !isLoading
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
