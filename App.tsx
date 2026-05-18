import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Editor } from './pages/Editor';
import { Player } from './pages/Player';
import { Auth } from './pages/Auth';
import { supabase } from './services/db';
import { auth } from './services/db';
import { User } from './types';
import { MapPin, LogOut } from 'lucide-react';

const AppShell: React.FC<{ user: User | null; onLogout: () => void }> = ({ user, onLogout }) => {
  const location = useLocation();
  const fullscreen = location.pathname.startsWith('/player/');

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {!fullscreen && (
        <header className="bg-zinc-950 text-white px-5 py-3.5 border-b border-zinc-800 z-10 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <MapPin className="text-emerald-400" size={20} />
            <span className="hidden sm:inline">Obelisk</span>
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-zinc-400 hidden sm:inline">{user.email}</span>
                <button
                  onClick={onLogout}
                  className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-400 hover:text-white"
                  title="Sign Out"
                >
                  <LogOut size={18} />
                </button>
              </>
            ) : (
              <span className="text-sm text-zinc-500">Guest Mode</span>
            )}
          </div>
        </header>
      )}

      <main className="flex-1 overflow-hidden relative">
        <Routes>
          <Route path="/auth" element={!user ? <Auth /> : <Navigate to="/" />} />
          <Route path="/" element={user ? <Dashboard user={user} /> : <Navigate to="/auth" />} />
          <Route path="/editor/:tourId?" element={user ? <Editor user={user} /> : <Navigate to="/auth" />} />
          <Route path="/player/:tourId" element={<Player />} />
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
        <MapPin className="text-emerald-400 animate-pulse" size={24} />
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
