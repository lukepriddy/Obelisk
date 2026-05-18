import React, { useState } from 'react';
import { auth } from '../services/db';
import { MapPin, Mail, ArrowLeft } from 'lucide-react';

export const Auth: React.FC = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setErrorMsg(null);

    const { error } = await auth.signInWithEmail(email.trim());

    setLoading(false);
    if (error) {
      setErrorMsg(error);
    } else {
      setSent(true);
    }
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
          {sent ? (
            /* ── Email sent state ── */
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <Mail className="text-emerald-400" size={24} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Check your email</h2>
                <p className="text-zinc-400 text-sm leading-relaxed">
                  We sent a sign-in link to<br />
                  <span className="text-white font-medium">{email}</span>
                </p>
              </div>
              <p className="text-xs text-zinc-600">
                Click the link in the email to continue. You can close this tab.
              </p>
              <button
                onClick={() => { setSent(false); setEmail(''); }}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mt-1"
              >
                <ArrowLeft size={12} /> Use a different email
              </button>
            </div>
          ) : (
            /* ── Email input state ── */
            <>
              <h2 className="text-xl font-bold text-white mb-1 text-center">Welcome back</h2>
              <p className="text-zinc-500 text-sm text-center mb-6">Enter your email to continue</p>

              <form onSubmit={handleSubmit} className="space-y-4">
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
                  {loading ? 'Sending link…' : 'Continue'}
                </button>
              </form>

              <p className="mt-5 text-[11px] text-center text-zinc-600">
                We'll email you a magic link — no password needed.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
