import React, { useState, useEffect, useRef } from 'react';
import { Zone, ChatMessage } from '../types';
import { geminiService } from '../services/geminiService';
import { audioService } from '../services/audioService';
import { Mic, Send, Square, ChevronDown, Volume2 } from 'lucide-react';

// Appended to every character system instruction so Gemini never
// adds stage directions like "(smiles)" or "(pauses solemnly)".
const NO_STAGE_DIRECTIONS =
  '\n\nCRITICAL: Respond with spoken words only. ' +
  'Never include stage directions, action descriptions, or parenthetical ' +
  'notes about physical actions, expressions, or emotions — e.g. never write ' +
  '(smiles), (pauses), (My gaze is steady), or anything in parentheses. ' +
  'Speak only as dialogue, exactly as it would be heard aloud.';

// Soft limits — voice goes silent first, then text winds down gracefully.
const VOICE_LIMIT = 20;  // TTS responses before character "loses voice"
const TEXT_LIMIT  = 50;  // further text-only replies before conversation ends

// Injected as model messages (not from the API) when limits are hit.
const VOICE_GONE_MSG =
  "My voice... it seems to be fading on me. I'll need to reach you through words alone from here — but I'm still with you.";
const CHAT_END_MSG =
  "I must leave you here for now. It's been a rare pleasure. Carry what we've shared with you.";

interface ChatInterfaceProps {
  zone: Zone;
  onClose: () => void;
  onUnlock?: (zoneId: string) => void;
  theme?: 'dark' | 'light';
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ zone, onClose, onUnlock, theme = 'dark' }) => {
  // ── History via sessionStorage — survives any remount within the same tab ──
  const storageKey = `obelisk_chat_${zone.id}`;
  const loadHistory = (): ChatMessage[] => {
    try { const s = sessionStorage.getItem(storageKey); return s ? JSON.parse(s) : []; }
    catch { return []; }
  };
  const savedHistory                  = loadHistory();
  const hasExistingHistory            = savedHistory.length > 0;
  const [history, setHistory]         = useState<ChatMessage[]>(savedHistory);
  const [isReady, setIsReady]         = useState(hasExistingHistory);
  const [isSending, setIsSending]     = useState(false);
  const [isSpeaking, setIsSpeaking]   = useState(false);
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);
  const [inputText, setInputText]     = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparingSpeech, setIsPreparingSpeech] = useState(false);
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);

  // ── Rate limits: voice fades at 20, text ends at 50 more ─────────────────
  // Derived from saved history so state survives remounts within the same tab.
  const savedModelCount = savedHistory.filter((m: ChatMessage) => m.role === 'model').length;
  const [voiceEnded, setVoiceEnded] = useState(savedModelCount > VOICE_LIMIT);
  const [chatLocked, setChatLocked] = useState(savedModelCount > VOICE_LIMIT + 1 + TEXT_LIMIT);
  const voiceCountRef = useRef(Math.min(savedModelCount, VOICE_LIMIT));
  const textCountRef  = useRef(Math.max(0, savedModelCount - VOICE_LIMIT - 1));

  const scrollRef      = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const hasGreetedRef  = useRef(hasExistingHistory); // skip greeting if history loaded
  const hasUnlockedRef = useRef(false);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Cleanup on unmount — stop mic and any dangling timers ────────────────
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        try { recognitionRef.current.stop(); } catch {}
        recognitionRef.current = null;
      }
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
      audioService.stopSpeech();
    };
  }, []); // runs once on mount; cleanup fires on unmount

  // ── Release mic when page is backgrounded (clears iOS Dynamic Island) ────
  // When the user minimises the browser we stop the recording immediately so
  // the mic indicator disappears.  On return they simply tap the mic again.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        if (recognitionRef.current) {
          recognitionRef.current.onresult = null;
          try { recognitionRef.current.stop(); } catch {}
          recognitionRef.current = null;
        }
        setIsRecording(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

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
    userBubble:     'bg-emerald-600 text-white rounded-br-md',
    aiBubble:       dk ? 'bg-zinc-800 text-zinc-100 rounded-bl-md' : 'bg-zinc-100 text-zinc-900 rounded-bl-md',
    typingDot:      dk ? 'bg-zinc-400' : 'bg-zinc-400',
    typingBg:       dk ? 'bg-zinc-800' : 'bg-zinc-100',
    inputBar:       dk ? 'border-zinc-800' : 'border-zinc-200',
    inputField:     dk ? 'bg-zinc-800 border-zinc-700 text-white placeholder-zinc-500 focus:border-indigo-500/60'
                       : 'bg-zinc-100 border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-indigo-400',
    micBtn:         dk ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-600',
    sendActive:     'bg-emerald-600 hover:bg-emerald-500 text-white',
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
  const playGeneratedSpeech = async (url: string, manual = false) => {
    setIsSpeaking(true);
    if (manual) setPendingAudioUrl(null);

    const played = await audioService.playSpeechUrl(url, {
      onStart: () => setIsSpeaking(true),
      onEnd: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });

    if (played) {
      setPendingAudioUrl(null);
      return;
    }

    setIsSpeaking(false);
    setPendingAudioUrl(url);
    if (!manual) setErrorMsg('Voice playback was blocked. Tap “Hear reply” to play it.');
  };

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, isSending]);

  // ── Persist history to sessionStorage on every change ───────────────────
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(history)); }
    catch {}
  }, [history, storageKey]);

  // ── Greeting on mount ─────────────────────────────────────────────────────
  // The greeting is TEXT ONLY — never voiced. Only the character's replies to
  // the player are read aloud. This keeps the opening instant and quiet.
  useEffect(() => {
    if (hasGreetedRef.current) return;
    hasGreetedRef.current = true;

    // A preset opening line is already written — show it instantly, no LLM call.
    if (zone.greeting_message?.trim()) {
      setHistory([{ role: 'model', text: zone.greeting_message.trim() }]);
      setIsReady(true);
      return;
    }

    // No preset line — generate one (text only).
    (async () => {
      try {
        const text = await geminiService.generateText(
          [], '[The player has arrived at your location. Greet them briefly and in character, then wait for them to respond.]',
          (zone.character_prompt || 'You are a helpful assistant.') + NO_STAGE_DIRECTIONS,
          zone.tour_id,
        );
        setHistory([{ role: 'model', text }]);
        setIsReady(true);
      } catch (err) {
        console.warn('Greeting failed:', err);
        setErrorMsg('Could not reach the character. Check your connection and try again.');
        setIsReady(true);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Speech recognition ────────────────────────────────────────────────────
  const setupSpeechRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (e: any) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      const spoken = (final || interim).trim();
      if (spoken) setInputText(spoken);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setIsRecording(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setIsRecording(false);
    };
    return recognition;
  };

  const cancelRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onend = null;
      recognitionRef.current.onerror = null;
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setIsRecording(false);
  };

  const stopListening = () => {
    if (!recognitionRef.current) return;
    try { recognitionRef.current.stop(); } catch { cancelRecording(); }
  };

  const toggleMic = async () => {
    if (isRecording) {
      stopListening();
    } else {
      try {
        const recognition = setupSpeechRecognition();
        if (!recognition) {
          setErrorMsg('Speech recognition is not available in this browser.');
          return;
        }
        recognitionRef.current = recognition;
        recognition.start();
        setIsRecording(true);
      } catch {
        setErrorMsg('Microphone access denied.');
      }
    }
  };

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending || chatLocked) return;

    // Re-prime the shared audio service inside the tap gesture. This mirrors
    // the zone-audio path and helps mobile browsers trust the later TTS play().
    audioService.prepareSpeechPlayback().catch(() => {});

    // Stop any active recording BEFORE clearing the input so onresult
    // can't race and refill the input after we clear it.
    cancelRecording();

    const newHistory: ChatMessage[] = [...history, { role: 'user', text }];
    setHistory(newHistory);
    setInputText('');
    setIsSending(true);
    setErrorMsg(null);

    try {
      const conversationHistory = newHistory.filter(m => m.role === 'user' || m.role === 'model');
      // Text first — show the reply immediately, voice it afterward.
      const replyText = await geminiService.generateText(
        conversationHistory.slice(0, -1), text,
        (zone.character_prompt || 'You are a helpful assistant.') + NO_STAGE_DIRECTIONS,
        zone.tour_id,
      );

      setHistory(prev => [...prev, { role: 'model', text: replyText }]);

      // Fire zone unlock exactly once, immediately on reply text arriving —
      // not gated on TTS completing, not repeated on subsequent messages.
      if (!hasUnlockedRef.current && zone.avatar_unlock_zone_id && onUnlock) {
        hasUnlockedRef.current = true;
        onUnlock(zone.avatar_unlock_zone_id);
      }

      // Creator can disable voice entirely (text-only) to cut cost at scale.
      const voiceOn = zone.voice_enabled !== false;

      if (voiceOn && !voiceEnded) {
        // Bookkeeping is synchronous; the actual TTS is fire-and-forget so the
        // "thinking" indicator clears as soon as the TEXT is shown (below), not
        // when the audio finishes generating.
        voiceCountRef.current++;
        if (voiceCountRef.current >= VOICE_LIMIT) {
          setHistory(prev => [...prev, { role: 'model', text: VOICE_GONE_MSG }]);
          setVoiceEnded(true);
        }
        setIsPreparingSpeech(true);
        geminiService
          .speak(replyText, zone.voice_style || 'Kore', zone.tour_id, zone.voice_instructions)
          .then(audioUrl => {
            if (audioUrl) {
              playGeneratedSpeech(audioUrl);
            } else {
              setErrorMsg('Voice audio could not be generated. The text reply is still available.');
            }
          })
          .catch(() => setErrorMsg('Voice audio could not be generated. The text reply is still available.'))
          .finally(() => setIsPreparingSpeech(false));
      } else {
        // ── Text-only phase ──
        textCountRef.current++;
        if (textCountRef.current >= TEXT_LIMIT) {
          // Gentle farewell, then lock
          setHistory(prev => [...prev, { role: 'model', text: CHAT_END_MSG }]);
          setChatLocked(true);
        }
      }
    } catch (err) {
      console.warn('sendMessage failed:', err);
      setErrorMsg('Something went wrong. Try again.');
    } finally {
      // Text is done → stop the "thinking"/typing state immediately. Audio (if
      // any) continues playing in the background and drives isSpeaking instead.
      setIsSending(false);
    }
  };

  const handleClose = () => {
    cancelRecording();
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    audioService.stopSpeech();
    if (pendingAudioUrl) { try { URL.revokeObjectURL(pendingAudioUrl); } catch {} }
    onClose();
  };

  const isLoading  = !isReady || isSending;
  const dotState   = isSpeaking ? 'speaking' : (isLoading || isPreparingSpeech) ? 'loading' : 'ready';
  const statusText = chatLocked  ? 'Conversation ended'
    : isSpeaking                 ? 'Speaking...'
    : pendingAudioUrl            ? 'Tap to hear'
    : isPreparingSpeech          ? 'Finding voice...'
    : isLoading                  ? 'Thinking...'
    : voiceEnded                 ? 'Text only'
    : 'Ready';

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
            {statusText}
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
        {errorMsg && (
          <div className={`text-sm px-4 py-3 rounded-2xl text-center border ${t.errorBg}`}>
            {errorMsg}
          </div>
        )}

        {pendingAudioUrl && (
          <button
            onClick={() => playGeneratedSpeech(pendingAudioUrl, true)}
            className="self-start flex items-center gap-2 px-3 py-2 rounded-full bg-indigo-500 text-white text-xs font-semibold shadow-lg active:scale-95 transition-transform"
          >
            <Volume2 size={14} /> Hear reply
          </button>
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

        {/* Typing indicator — shows while greeting is loading OR AI is responding */}
        {(!isReady || isSending) && (
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
            disabled={isLoading || chatLocked}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              isRecording ? 'bg-red-500 text-white' : `${t.micBtn} disabled:opacity-40`
            }`}
          >
            {isRecording ? <Square size={15} fill="currentColor" /> : <Mic size={15} />}
          </button>

          <textarea
            ref={textareaRef}
            className={`flex-1 border rounded-2xl px-3.5 py-2.5 focus:outline-none resize-none leading-snug disabled:opacity-40 ${t.inputField}`}
            placeholder={chatLocked ? 'Conversation ended' : !isReady ? 'Starting…' : isSending ? 'Thinking…' : 'Message…'}
            value={inputText}
            rows={1}
            disabled={isLoading || chatLocked}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            style={{ fontSize: '16px', overflowY: 'hidden' }}
          />

          <button
            onClick={sendMessage}
            disabled={!inputText.trim() || isLoading || chatLocked}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              inputText.trim() && !isLoading && !chatLocked ? t.sendActive : t.sendInactive
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
