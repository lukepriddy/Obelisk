import React, { useState, useEffect, useRef } from 'react';
import { Zone, ChatMessage } from '../types';
import { geminiService } from '../services/geminiService';
import { Send, X } from 'lucide-react';

// Appended to every character system instruction so Gemini never
// adds stage directions like "(smiles)" or "(pauses solemnly)".
const NO_STAGE_DIRECTIONS =
  '\n\nCRITICAL: Respond with spoken words only. ' +
  'Never include stage directions, action descriptions, or parenthetical ' +
  'notes about physical actions, expressions, or emotions — e.g. never write ' +
  '(smiles), (pauses), (My gaze is steady), or anything in parentheses. ' +
  'Speak only as dialogue, exactly as it would be heard aloud. ' +
  'Keep replies concise and voice-chat natural: usually 1 to 3 short sentences unless the player asks for detail.';

const TEXT_LIMIT  = 70;  // text replies before conversation ends

// Injected as model messages (not from the API) when limits are hit.
const CHAT_END_MSG =
  "I must leave you here for now. It's been a rare pleasure. Carry what we've shared with you.";

interface ChatInterfaceProps {
  zone: Zone;
  onClose: () => void;
  onUnlock?: (zoneId: string) => void;
  theme?: 'dark' | 'light';
  accent?: string;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ zone, onClose, onUnlock, theme = 'dark', accent = '#10b981' }) => {
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
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);
  const [inputText, setInputText]     = useState('');
  const [dragOffset, setDragOffset]   = useState(0);
  const [isDraggingHandle, setIsDraggingHandle] = useState(false);

  // ── Rate limits: conversation winds down gracefully ───────────────────────
  // Derived from saved history so state survives remounts within the same tab.
  const savedModelCount = savedHistory.filter((m: ChatMessage) => m.role === 'model').length;
  const [chatLocked, setChatLocked] = useState(savedModelCount >= TEXT_LIMIT);
  const textCountRef  = useRef(savedModelCount);

  // Bumped after the keyboard is dismissed to REMOUNT the fixed root — iOS can
  // leave a fixed element painted a few px off after the keyboard closes while
  // every JS metric reads in-sync; recreating the element is the one reliable
  // repaint. History lives in sessionStorage so nothing is lost, and the
  // greeting is skipped when history already exists (no re-greet).
  const [kbNudge, setKbNudge] = useState(0);

  const scrollRef      = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const hasGreetedRef  = useRef(hasExistingHistory); // skip greeting if history loaded
  const hasUnlockedRef = useRef(false);
  const handleStartYRef = useRef<number | null>(null);

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
    userBubble:     'text-white rounded-br-md',   // background set inline from accent
    aiBubble:       dk ? 'bg-zinc-800 text-zinc-100 rounded-bl-md' : 'bg-zinc-100 text-zinc-900 rounded-bl-md',
    typingDot:      dk ? 'bg-zinc-400' : 'bg-zinc-400',
    typingBg:       dk ? 'bg-zinc-800' : 'bg-zinc-100',
    inputBar:       dk ? 'border-zinc-800' : 'border-zinc-200',
    inputField:     dk ? 'bg-zinc-800 border-zinc-700 text-white placeholder-zinc-500 focus:border-indigo-500/60'
                       : 'bg-zinc-100 border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-indigo-400',
    sendActive:     'text-white',   // background set inline from accent
    sendInactive:   dk ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-zinc-100 text-zinc-400 cursor-not-allowed',
    spinnerBorder:  dk ? 'border-zinc-700 border-t-indigo-400' : 'border-zinc-300 border-t-indigo-500',
    spinnerText:    dk ? 'text-zinc-500' : 'text-zinc-500',
    handle:         dk ? 'bg-white/20' : 'bg-black/15',
    // 'ready' colour comes from the accent inline; 'loading' stays amber.
    statusDot: (state: 'loading' | 'ready') =>
      state === 'loading' ? 'bg-amber-400 animate-pulse' : '',
  };

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  // kbNudge in the deps so the remounted (keyboard-dismiss) message list snaps
  // back to the bottom instead of showing the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, isSending, kbNudge]);

  // ── Persist history to sessionStorage on every change ───────────────────
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(history)); }
    catch {}
  }, [history, storageKey]);

  // ── Greeting on mount ─────────────────────────────────────────────────────
  // Text-only greeting. Character voice playback is disabled in the public
  // player until the new voice mode is rebuilt behind a separate flag.
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

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending || chatLocked) return;

    const newHistory: ChatMessage[] = [...history, { role: 'user', text }];
    setHistory(newHistory);
    setInputText('');
    setIsSending(true);
    setErrorMsg(null);

    try {
      const conversationHistory = newHistory.filter(m => m.role === 'user' || m.role === 'model');
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

      textCountRef.current++;
      if (textCountRef.current >= TEXT_LIMIT) {
        setHistory(prev => [...prev, { role: 'model', text: CHAT_END_MSG }]);
        setChatLocked(true);
      }
    } catch (err) {
      console.warn('sendMessage failed:', err);
      setErrorMsg('Something went wrong. Try again.');
    } finally {
      setIsSending(false);
    }
  };

  const handleClose = () => {
    onClose();
  };

  const isLoading  = !isReady || isSending;
  const dotState   = isLoading ? 'loading' : 'ready';
  const statusText = chatLocked  ? 'Conversation ended'
    : isLoading                  ? 'Thinking...'
    : 'Ready';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      key={kbNudge}
      className={`
        overlay-edge-bleed chat-edge-shield fixed inset-0 z-[5000]
        flex flex-col px-8
        md:inset-auto md:bottom-6 md:right-6
        md:w-[420px] md:h-[600px] md:px-0
        md:rounded-2xl md:border md:shadow-2xl
        ${t.root}
      `}
      style={{
        '--chat-edge-bg': dk ? '#09090b' : '#ffffff',
        transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
        transition: isDraggingHandle ? 'none' : 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {/* ── Drag handle — downward swipe dismisses; the X remains the explicit close. */}
      <div
        onTouchStart={(event) => {
          handleStartYRef.current = event.touches[0]?.clientY ?? null;
          setIsDraggingHandle(true);
        }}
        onTouchMove={(event) => {
          const startY = handleStartYRef.current;
          if (startY === null || !event.touches[0]) return;
          const offset = Math.max(0, event.touches[0].clientY - startY);
          setDragOffset(offset);
          if (offset > 0) event.preventDefault();
        }}
        onTouchEnd={(event) => {
          const startY = handleStartYRef.current;
          handleStartYRef.current = null;
          setIsDraggingHandle(false);
          const offset = startY !== null && event.changedTouches[0]
            ? Math.max(0, event.changedTouches[0].clientY - startY)
            : 0;
          if (offset > 96) {
            handleClose();
          } else {
            setDragOffset(0);
          }
        }}
        onTouchCancel={() => {
          handleStartYRef.current = null;
          setIsDraggingHandle(false);
          setDragOffset(0);
        }}
        className="flex items-center justify-center pt-3 pb-1.5 w-full shrink-0 touch-none"
        aria-hidden="true"
      >
        <div className={`w-10 h-[3px] rounded-full ${t.handle}`} />
      </div>

      {/* ── Header ── */}
      <div className={`flex items-center gap-3 px-0 pt-0.5 pb-3 border-b shrink-0 md:px-4 ${t.header}`}>
        {zone.character_image_url ? (
          <div className="relative shrink-0">
            <img src={zone.character_image_url} alt={zone.title} className="w-9 h-9 rounded-lg object-cover" />
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 transition-colors ${dk ? 'border-zinc-950' : 'border-white'} ${t.statusDot(dotState)}`}
              style={dotState === 'ready' ? { backgroundColor: accent } : undefined}
            />
          </div>
        ) : (
          <div
            className={`w-2 h-2 rounded-full shrink-0 transition-colors ${t.statusDot(dotState)}`}
            style={dotState === 'ready' ? { backgroundColor: accent } : undefined}
          />
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
          <X size={20} />
        </button>
      </div>

      {/* ── Chat log ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-0 pt-3 pb-6 flex flex-col gap-3 min-h-0 md:px-4">
        {errorMsg && (
          <div className={`text-sm px-4 py-3 rounded-2xl text-center border ${t.errorBg}`}>
            {errorMsg}
          </div>
        )}

        {history.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user' ? t.userBubble : t.aiBubble
              }`}
              style={msg.role === 'user' ? { backgroundColor: accent } : undefined}
            >
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
        className={`relative px-0 pt-2 shrink-0 before:absolute before:top-0 before:-left-4 before:h-px before:w-[calc(100%+2rem)] md:px-3 md:before:left-0 md:before:w-full ${dk ? 'before:bg-zinc-800' : 'before:bg-zinc-200'}`}
        style={{ paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            className={`flex-1 border rounded-2xl px-3.5 py-2.5 focus:outline-none resize-none leading-snug disabled:opacity-40 ${t.inputField}`}
            placeholder={chatLocked ? 'Conversation ended' : !isReady ? 'Starting…' : isSending ? 'Thinking…' : 'Message…'}
            value={inputText}
            rows={1}
            disabled={isLoading || chatLocked}
            onChange={(e) => setInputText(e.target.value)}
            onBlur={() => {
              // Keyboard dismissed → remount the fixed root to repaint it (see
              // kbNudge), unless focus just moved elsewhere in the chat.
              window.setTimeout(() => {
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
                setKbNudge(n => n + 1);
              }, 350);
            }}
            style={{ fontSize: '16px', overflowY: 'hidden' }}
          />

          <button
            onClick={sendMessage}
            disabled={!inputText.trim() || isLoading || chatLocked}
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
              inputText.trim() && !isLoading && !chatLocked ? t.sendActive : t.sendInactive
            }`}
            style={inputText.trim() && !isLoading && !chatLocked ? { backgroundColor: accent } : undefined}
          >
            <Send size={15} />
          </button>
        </div>

      </div>
    </div>
  );
};
