import React, { useState, useRef, useEffect } from 'react';
import { auth } from '../services/db';
import { MapPin, Mail, ArrowLeft } from 'lucide-react';

export const Auth: React.FC = () => {
  const [email, setEmail]     = useState('');
  const [code, setCode]       = useState(['', '', '', '', '', '', '', '']);
  const [step, setStep]       = useState<'email' | 'code'>('email');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Auto-focus first code box when we reach the code step
  useEffect(() => {
    if (step === 'code') inputRefs.current[0]?.focus();
  }, [step]);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setErrorMsg(null);
    const { error } = await auth.signInWithEmail(email.trim());
    setLoading(false);
    if (error) { setErrorMsg(error); return; }
    setStep('code');
  };

  const handleCodeChange = (index: number, value: string) => {
    // Allow paste of full 6-digit code
    if (value.length === 8 && /^\d{8}$/.test(value)) {
      const digits = value.split('');
      setCode(digits);
      inputRefs.current[7]?.focus();
      verifyCode(digits.join(''));
      return;
    }
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...code];
    next[index] = digit;
    setCode(next);
    if (digit && index < 7) inputRefs.current[index + 1]?.focus();
    if (next.every(d => d !== '')) verifyCode(next.join(''));
  };

  const handleCodeKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const verifyCode = async (token: string) => {
    setLoading(true);
    setErrorMsg(null);
    const { error } = await auth.verifyOtp(email.trim(), token);
    setLoading(false);
    if (error) {
      setErrorMsg('Incorrect code — check your email and try again.');
      setCode(['', '', '', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    }
    // On success Supabase fires onAuthStateChange → App.tsx handles navigation
  };

  const handleBack = () => {
    setStep('email');
    setCode(['', '', '', '', '', '', '', '']);
    setErrorMsg(null);
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <MapPin className="text-emerald-400" size={24} />
          <span className="text-white font-bold text-2xl tracking-tight">Obelisk</span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 shadow-2xl">

          {step === 'email' ? (
            /* ── Step 1: Email ── */
            <>
              <h2 className="text-xl font-bold text-white mb-1 text-center">Welcome back</h2>
              <p className="text-zinc-500 text-sm text-center mb-6">Enter your email to get a sign-in code</p>

              <form onSubmit={handleSendCode} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">
                    Email Address
                  </label>
                  <input
                    type="email"
                    required
                    autoFocus
                    className="w-full px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-xl text-white placeholder-zinc-600 text-sm focus:outline-none focus:border-emerald-500/60 transition-colors"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                {errorMsg && (
                  <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    {errorMsg}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold py-2.5 px-4 rounded-xl transition-colors text-sm"
                >
                  {loading ? 'Sending…' : 'Send Code'}
                </button>
              </form>

              <p className="mt-5 text-[11px] text-center text-zinc-600">
                We'll email you an 8-digit code — no password needed.
              </p>
            </>
          ) : (
            /* ── Step 2: Code entry ── */
            <>
              <div className="flex flex-col items-center text-center gap-1 mb-6">
                <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mb-2">
                  <Mail className="text-emerald-400" size={24} />
                </div>
                <h2 className="text-xl font-bold text-white">Check your email</h2>
                <p className="text-zinc-400 text-sm">
                  Enter the 8-digit code sent to<br />
                  <span className="text-white font-medium">{email}</span>
                </p>
              </div>

              {/* Code boxes */}
              <div className="flex gap-2 justify-center mb-4">
                {code.map((digit, i) => (
                  <input
                    key={i}
                    ref={el => { inputRefs.current[i] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={digit}
                    onChange={(e) => handleCodeChange(i, e.target.value)}
                    onKeyDown={(e) => handleCodeKeyDown(i, e)}
                    disabled={loading}
                    className="w-9 h-12 text-center text-lg font-bold bg-zinc-800 border border-zinc-700 rounded-xl text-white focus:outline-none focus:border-emerald-500 transition-colors disabled:opacity-50"
                  />
                ))}
              </div>

              {errorMsg && (
                <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-center mb-3">
                  {errorMsg}
                </p>
              )}

              {loading && (
                <p className="text-zinc-500 text-xs text-center mb-3">Verifying…</p>
              )}

              <div className="flex flex-col items-center gap-2 mt-2">
                <button
                  onClick={handleBack}
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  <ArrowLeft size={12} /> Use a different email
                </button>
                <button
                  onClick={() => auth.signInWithEmail(email.trim())}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Resend code
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
