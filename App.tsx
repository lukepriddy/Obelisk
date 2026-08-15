import React, { useState, useEffect } from 'react';
import { BrandMark } from './components/BrandMark';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Editor } from './pages/Editor';
import { Player } from './pages/Player';
import { AdminModeration } from './pages/AdminModeration';
import { LegalPage } from './pages/LegalPage';
import { ReportPage } from './pages/ReportPage';
import { TERMS_SECTIONS, TERMS_VERSION } from './constants/terms';
import { PLAYER_TERMS_SECTIONS, PLAYER_TERMS_VERSION } from './constants/playerTerms';
import { PRIVACY_SECTIONS, PRIVACY_VERSION } from './constants/privacy';
import { LICENSES_SECTIONS, LICENSES_VERSION } from './constants/licenses';
import { Auth } from './pages/Auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { supabase } from './services/db';
import { auth } from './services/db';
import { User } from './types';
import { LogOut } from 'lucide-react';

const AppShell: React.FC<{ user: User | null; onLogout: () => void }> = ({ user, onLogout }) => {
  const location = useLocation();
  const isPlayer    = location.pathname.startsWith('/player/');
  const isEditor    = location.pathname.startsWith('/editor');
  const isDashboard = location.pathname === '/';

  // Dashboard owns its own sidebar chrome — don't render the top header there.
  const showHeader = !isPlayer && !isDashboard;

  return (
    <div className={`flex flex-col h-dvh overflow-hidden ${isEditor ? 'bg-zinc-950' : 'bg-zinc-950'}`}>
      {showHeader && (
        <header className={`px-5 py-3.5 z-10 flex justify-between items-center shrink-0 ${
          isEditor
            ? 'bg-zinc-950 text-white border-b border-zinc-800'
            : 'bg-zinc-950 text-white border-b border-zinc-800'
        }`}>
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <BrandMark size={20} color="#10b981" />
            <span className="text-white hidden sm:inline">Obelisk</span>
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-zinc-400 hidden sm:inline">{user.email}</span>
                <button
                  onClick={onLogout}
                  className="p-2 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                  title="Sign Out"
                >
                  <LogOut size={18} />
                </button>
              </>
            ) : (
              <span className="text-sm text-zinc-400">Guest Mode</span>
            )}
          </div>
        </header>
      )}

      <main className="flex-1 overflow-hidden relative">
        <Routes>
          <Route path="/auth" element={!user ? <Auth /> : <Navigate to="/" />} />
          <Route path="/" element={user ? <Dashboard user={user} onLogout={onLogout} /> : <Navigate to="/auth" />} />
          <Route path="/editor/:tourId?" element={user ? <Editor user={user} /> : <Navigate to="/auth" />} />
          <Route path="/player/:tourId" element={<ErrorBoundary><Player /></ErrorBoundary>} />
          {/* Admin membership is enforced by the edge function, not this route. */}
          <Route path="/admin/moderation" element={user ? <AdminModeration /> : <Navigate to="/auth" />} />
          {/* Public by design: a creator should be able to read the terms
              before signing up, and a player needs the privacy policy without
              ever having an account. The report route goes further — it has to
              work for someone who has never used Obelisk and is objecting to an
              experience they found the hard way. */}
          <Route path="/report" element={<ReportPage />} />
          <Route
            path="/terms"
            element={
              <LegalPage
                title="Creator terms"
                intro="These apply when you publish an experience. The first section is the one that matters most."
                sections={TERMS_SECTIONS}
                version={TERMS_VERSION}
              />
            }
          />
          <Route
            path="/player-terms"
            element={
              <LegalPage
                title="Playing an experience"
                intro="These apply when you take part in an experience. The first section is the one that matters most."
                sections={PLAYER_TERMS_SECTIONS}
                version={PLAYER_TERMS_VERSION}
              />
            }
          />
          <Route
            path="/privacy"
            element={
              <LegalPage
                title="Privacy"
                intro="What Obelisk collects, why, and what you can do about it."
                sections={PRIVACY_SECTIONS}
                version={PRIVACY_VERSION}
              />
            }
          />
          <Route
            path="/licenses"
            element={
              <LegalPage
                title="Third-party notices"
                intro="Obelisk is built on other people's work. Several of these licences require attribution — this page is where it lives."
                sections={LICENSES_SECTIONS}
                version={LICENSES_VERSION}
              />
            }
          />
        </Routes>
      </main>
    </div>
  );
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Pick up existing session on load (also handles magic-link redirect)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email ?? '' });
      }
      setLoading(false);
    });

    // Keep user state in sync with Supabase auth events
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email ?? '' });
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await auth.signOut();
    setUser(null);
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <div className="flex items-center gap-3 text-white">
        <BrandMark size={24} className="animate-pulse" />
        <span className="font-bold text-lg">Loading Obelisk...</span>
      </div>
    </div>
  );

  return (
    <BrowserRouter>
      <AppShell user={user} onLogout={handleLogout} />
    </BrowserRouter>
  );
};

export default App;
