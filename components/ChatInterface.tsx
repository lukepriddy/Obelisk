import React, { useState, useEffect, useRef } from 'react';
import { Zone, ChatMessage } from '../types';
import { geminiService } from '../services/geminiService';
import { audioService } from '../services/audioService';
import { Mic, Send, Square, ChevronDown } from 'lucide-react';

// Appended to every character system instruction so Gemini never
// adds stage directions like "(smiles)" or "(pauses solemnly)".
const NO_STAGE_DIRECTIONS =
  '\n\nCRITICAL: Respond with spoken words only. ' +
  'Never include stage directions, action descriptions, or parenthetical ' +
  'notes about physical actions, expressions, or emotions — e.g. never write ' +
  '(smiles), (pauses), (My gaze is steady), or anything in parentheses. ' +
  'Speak only as dialogue, exactly as it would be heard aloud.';

interface ChatInterfaceProps {
  zone: Zone;
  onClose: () => void;
  onUnlock?: (zoneId: string) => void;
  theme?: 'dark' | 'light';
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ zone, onClose, onUnlock, theme = 'dark' }) => {
  const [history, setHistory]       = useState<ChatMessage[]>([]);
  const [isReady, setIsReady]       = useState(false);
  const [isSending, setIsSending]   = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);
  const [inputText, setInputText]   = useState('');
  const [isRecording, setIsRecording] = useState(false);

  const scrollRef      = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const micStreamRef   = useRef<MediaStream | null>(null);
  const hasGreetedRef  = useRef(false);
  const hasUnlockedRef = useRef(false);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Textarea auto-resize ──────────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [inputText]);

  // ── Theme tokens ──────────────────────────────────────────────────────────
  const dk = theme === 'dark';
  const t = {
    root:           dk ? 'bg-zinc-950 border-zinc-800/80' : 'bg-white border-zinc-200',
    header:         dk ? 'border-zinc-800'                : 'border-zinc-200',
    headerText:     dk ? 'text-white'                     : 'text-zinc-900',
    headerMuted:    dk ? 'text-zinc-500'                  : 'text-zinc-500',
    closeBtn:       dk ? 'text-zinc-400 hover:text-white hover:bg-zinc-800' : 'text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100',
    errorBg:        dk ? 'bg-red-500/10 border-red-500/30 text-red-300' : 'bg-red-50 border-red-200 text-red-600',
    userBubble:     'bg-indigo-600 text-white rounded-br-md',
    aiBubble:       dk ? 'bg-zinc-800 text-zinc-100 rounded-bl-md' : 'bg-zinc-100 text-zinc-900 rounded-bl-md',
    typingDot:      dk ? 'bg-zinc-400' : 'bg-zinc-400',
    typingBg:       dk ? 'bg-zinc-800' : 'bg-zinc-100',
    inputBar:       dk ? 'border-zinc-800' : 'border-zinc-200',
    inputField:     dk ? 'bg-zinc-800 border-zinc-700 text-white placeholder-zinc-500 focus:border-indigo-500/60'
                       : 'bg-zinc-100 border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-indigo-400',
    micBtn:         dk ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-600',
    sendActive:     'bg-indigo-600 hover:bg-indigo-500 text-white',
    sendInactive:   dk ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-zinc-100 text-zinc-400 cursor-not-allowed',
    recordingLabel: dk ? 'text-red-400' : 'text-red-500',
    spinnerBorder:  dk ? 'border-zinc-700 border-t-indigo-400' : 'border-zinc-300 border-t-indigo-500',
    spinnerText:    dk ? 'text-zinc-500' : 'text-zinc-500',
    handle:         dk ? 'bg-white/20' : 'bg-black/15',
    statusDot: (state: 'speaking' | 'loading' | 'ready') =>
      state === 'speaking' ? 'bg-indigo-400 animate-pulse'
      : state === 'loading' ? 'bg-amber-400 animate-pulse'
      : 'bg-emerald-400',
  };

  // ── Audio playback ────────────────────────────────────────────────────────
  const playAudio = async (buffer: AudioBuffer) => {
    try {
      const ctx = audioService.context;
      if (!ctx) return;
      if (ctx.state === 'suspended') await ctx.resume();

      setIsSpeaking(true);
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = setTimeout(() => setIsSpeaking(false), (buffer.duration + 3) * 1000);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      src.onended = () => {
        if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
        setIsSpeaking(false);
      };
    } catch (err) {
      console.warn('playAudio failed:', err);
      setIsSpeaking(false);
    }
  };

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, isSending]);

  // ── Greeting on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    if (hasGreetedRef.current) return;
    hasGreetedRef.current = true;

    const fetchGreeting = async () => {
      const greetingPrompt = zone.greeting_message
        ? `[The player has arrived. Your exact opening line is: "${zone.greeting_message}" — say it now, word for word, then wait for the player to respond.]`
        : '[The player has arrived at your location. Greet them briefly and in character, then wait for them to respond.]';
      try {
        const { text } = await geminiService.generateCharacterResponse(
          [], greetingPrompt,
          (zone.character_prompt || 'You are a helpful assistant.') + NO_STAGE_DIRECTIONS,
          zone.voice_style || 'Kore',
        );
        setHistory([{ role: 'model', text }]);
        setIsReady(true);
      } catch (err) {
        console.warn('Greeting failed:', err);
        setErrorMsg('Could not reach the character. Check your connection and try again.');
        setIsReady(true);
      }
    };
    fetchGreeting();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Speech recognition ────────────────────────────────────────────────────
  const setupSpeechRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (e: any) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setInputText(final || interim);
    };
    recognition.onend  = () => setIsRecording(false);
    recognition.onerror = () => setIsRecording(false);
    recognitionRef.current = recognition;
  };

  const stopRecording = () => {
    if (recognitionRef.current && isRecording) {
      recognitionRef.current.onresult = null;
      try { recognitionRef.current.stop(); } catch {}
      setIsRecording(false);
    }
  };

  const toggleMic = async () => {
    if (!recognitionRef.current) {
      setupSpeechRecognition();
      if (!recognitionRef.current) return;
    }
    if (isRecording) {
      stopRecording();
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

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;

    // Stop any active recording BEFORE clearing the input so onresult
    // can't race and refill the input after we clear it.
    stopRecording();

    const newHistory: ChatMessage[] = [...history, { role: 'user', text }];
    setHistory(newHistory);
    setInputText('');
    setIsSending(true);
    setErrorMsg(null);

    try {
      const conversationHistory = newHistory.filter(m => m.role === 'user' || m.role === 'model');
      const { text: replyText, audioBuffer } = await geminiService.generateCharacterResponse(
        conversationHistory.slice(0, -1), text,
        (zone.character_prompt || 'You are a helpful assistant.') + NO_STAGE_DIRECTIONS,
        zone.voice_style || 'Kore',
      );

      setHistory(prev => [...prev, { role: 'model', text: replyText }]);

      // Fire zone unlock exactly once, immediately on reply text arriving —
      // not gated on TTS completing, not repeated on subsequent messages.
      if (!hasUnlockedRef.current && zone.avatar_unlock_zone_id && onUnlock) {
        hasUnlockedRef.current = true;
        onUnlock(zone.avatar_unlock_zone_id);
      }

      if (audioBuffer) await playAudio(audioBuffer);
    } catch (err) {
      console.warn('sendMessage failed:', err);
      setErrorMsg('Something went wrong. Try again.');
    } finally {
      setIsSending(false);
    }
  };

  const handleClose = () => {
    stopRecording();
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    onClose();
  };

  const isLoading = !isReady || isSending;
  const dotState  = isSpeaking ? 'speaking' : isLoading ? 'loading' : 'ready';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className={`
        fixed inset-0 z-[5000]
        flex flex-col
        md:inset-auto md:bottom-6 md:right-6
        md:w-[420px] md:h-[600px]
        md:rounded-2xl md:border md:shadow-2xl
        ${t.root}
      `}
    >
      {/* ── Drag handle — also a close affordance ── */}
      <button
        onClick={handleClose}
        aria-label="Close"
        className="flex items-center justify-center pt-3 pb-1.5 w-full shrink-0"
      >
        <div className={`w-10 h-[3px] rounded-full ${t.handle}`} />
      </button>

      {/* ── Header ── */}
      <div className={`flex items-center gap-3 px-4 pt-0.5 pb-3 border-b shrink-0 ${t.header}`}>
        {zone.character_image_url ? (
          <div className="relative shrink-0">
            <img src={zone.character_image_url} alt={zone.title} className="w-9 h-9 rounded-full object-cover" />
            <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 transition-colors ${dk ? 'border-zinc-950' : 'border-white'} ${t.statusDot(dotState)}`} />
          </div>
        ) : (
          <div className={`w-2 h-2 rounded-full shrink-0 transition-colors ${t.statusDot(dotState)}`} />
        )}
        <div className="flex-1 min-w-0">
          <h3 className={`font-semibold text-sm leading-tight truncate ${t.headerText}`}>{zone.title}</h3>
          <p className={`text-[10px] uppercase tracking-wider mt-0.5 ${t.headerMuted}`}>
            {isSpeaking ? 'Speaking...' : isSending ? 'Thinking...' : !isReady ? 'Starting...' : 'Ready'}
          </p>
        </div>
        <button
          onClick={handleClose}
          className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors shrink-0 ${t.closeBtn}`}
          aria-label="Close chat"
        >
          <ChevronDown size={20} />
        </button>
      </div>

      {/* ── Chat log ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-6 flex flex-col gap-3 min-h-0">
        {!isReady && (
          <div className={`flex items-center justify-center gap-2 py-8 ${t.spinnerText}`}>
            <div className={`w-5 h-5 border-2 rounded-full animate-spin ${t.spinnerBorder}`} />
            <span className="text-sm">Connecting to {zone.title}…</span>
          </div>
        )}

        {errorMsg && (
          <div className={`text-sm px-4 py-3 rounded-2xl text-center border ${t.errorBg}`}>
            {errorMsg}
          </div>
        )}

        {history.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user' ? t.userBubble : t.aiBubble
            }`}>
              {msg.text}
            </div>
          </div>
        ))}

        {isSending && (
          <div className="flex justify-start">
            <div className={`px-4 py-3 rounded-2xl rounded-bl-md flex gap-1.5 items-center ${t.typingBg}`}>
              <span className={`w-1.5 h-1.5 rounded-full animate-bounce ${t.typingDot}`} style={{ animationDelay: '0ms' }} />
              <span className={`w-1.5 h-1.5 rounded-full animate-bounce ${t.typingDot}`} style={{ animationDelay: '120ms' }} />
              <span className={`w-1.5 h-1.5 rounded-full animate-bounce ${t.typingDot}`} style={{ animationDelay: '240ms' }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Input bar ── */}
      <div
        className={`px-3 pt-2 shrink-0 border-t ${t.inputBar}`}
        style={{ paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-end gap-2">
          <button
            onClick={toggleMic}
            disabled={isLoading}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              isRecording ? 'bg-red-500 text-white' : `${t.micBtn} disabled:opacity-40`
            }`}
          >
            {isRecording ? <Square size={15} fill="currentColor" /> : <Mic size={15} />}
          </button>

          <textarea
            ref={textareaRef}
            className={`flex-1 border rounded-2xl px-3.5 py-2.5 focus:outline-none resize-none leading-snug disabled:opacity-40 ${t.inputField}`}
            placeholder={!isReady ? 'Starting…' : isSending ? 'Thinking…' : 'Message…'}
            value={inputText}
            rows={1}
            disabled={isLoading}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            style={{ fontSize: '16px', overflowY: 'hidden' }}
          />

          <button
            onClick={sendMessage}
            disabled={!inputText.trim() || isLoading}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              inputText.trim() && !isLoading ? t.sendActive : t.sendInactive
            }`}
          >
            <Send size={15} />
          </button>
        </div>

        {isRecording && (
          <p className={`text-[10px] text-center mt-1.5 animate-pulse ${t.recordingLabel}`}>Listening…</p>
        )}
      </div>
    </div>
  );
};
