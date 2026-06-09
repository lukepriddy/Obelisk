import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  getToursByUser,
  createTour as dbCreateTour,
  deleteTour as dbDeleteTour,
  getZoneCountsByTourIds,
  duplicateTour as dbDuplicateTour,
} from '../services/db';
import { Tour, User } from '../types';
import {
  Plus, Play, Edit2, Map, Link2, Check, Trash2, AlertTriangle,
  MapPin, LogOut, BarChart2, Globe, Lock, Copy, Search,
  ChevronDown, Layers, Clock, SortAsc,
} from 'lucide-react';

interface DashboardProps {
  user: User;
  onLogout: () => void;
}

type SortKey = 'newest' | 'oldest' | 'az' | 'za';
type FilterKey = 'all' | 'public' | 'private';

// ── Sidebar nav item ────────────────────────────────────────────────────────
const NavItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  onClick?: () => void;
}> = ({ icon, label, active, disabled, badge, onClick }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`
      w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium
      transition-colors text-left
      ${active
        ? 'bg-emerald-500/15 text-emerald-400'
        : disabled
          ? 'text-zinc-600 cursor-default'
          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}
    `}
  >
    <span className="shrink-0">{icon}</span>
    <span className="flex-1 truncate">{label}</span>
    {badge && (
      <span className="text-[9px] font-bold uppercase tracking-wider bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded-full">
        {badge}
      </span>
    )}
    {active && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
  </button>
);

// ── Stat card ───────────────────────────────────────────────────────────────
const StatCard: React.FC<{ label: string; value: number | string; icon: React.ReactNode; color: string }> = ({ label, value, icon, color }) => (
  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-4 flex items-center gap-4">
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
      {icon}
    </div>
    <div>
      <p className="text-2xl font-bold text-white leading-none">{value}</p>
      <p className="text-xs text-zinc-500 mt-0.5">{label}</p>
    </div>
  </div>
);

export const Dashboard: React.FC<DashboardProps> = ({ user, onLogout }) => {
  const [tours, setTours]             = useState<Tour[]>([]);
  const [zoneCounts, setZoneCounts]   = useState<Record<string, number>>({});
  const [creating, setCreating]       = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedId, setCopiedId]       = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId]   = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [activeNav, setActiveNav]     = useState<'tours' | 'analytics'>('tours');
  const [search, setSearch]           = useState('');
  const [sort, setSort]               = useState<SortKey>('newest');
  const [filter, setFilter]           = useState<FilterKey>('all');
  const [loadingTours, setLoadingTours] = useState(true);

  const navigate = useNavigate();

  useEffect(() => { loadTours(); }, []);

  const loadTours = async () => {
    setLoadingTours(true);
    const data = await getToursByUser(user.id);
    setTours(data);
    if (data.length) {
      const counts = await getZoneCountsByTourIds(data.map(t => t.id));
      setZoneCounts(counts);
    }
    setLoadingTours(false);
  };

  // ── Derived stats ────────────────────────────────────────────────────────
  const totalZones  = Object.values(zoneCounts).reduce((s, c) => s + c, 0);
  const publicCount = tours.filter(t => t.is_public).length;

  // ── Filtered + sorted tour list ──────────────────────────────────────────
  const visibleTours = useMemo(() => {
    let list = [...tours];
    if (filter === 'public')  list = list.filter(t => t.is_public);
    if (filter === 'private') list = list.filter(t => !t.is_public);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      if (sort === 'newest') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sort === 'oldest') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (sort === 'az') return a.title.localeCompare(b.title);
      if (sort === 'za') return b.title.localeCompare(a.title);
      return 0;
    });
    return list;
  }, [tours, filter, search, sort]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const createTour = async () => {
    setCreating(true);
    setCreateError(null);
    const tour = await dbCreateTour({
      owner_id: user.id,
      title: 'Untitled Experience',
      description: 'Describe your experience here.',
      is_public: true,
      lat: 40.7484,
      lng: -73.9856,
    });
    setCreating(false);
    if (tour) navigate(`/editor/${tour.id}`);
    else setCreateError('Failed to create. Check your connection and try again.');
  };

  const copyPlayerLink = (tourId: string) => {
    const url = `${window.location.origin}/player/${tourId}`;
    if (navigator.share) {
      navigator.share({ title: 'Join my Obelisk experience', url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setCopiedId(tourId);
        setTimeout(() => setCopiedId(null), 2000);
      });
    }
  };

  const handleDelete = async (tourId: string) => {
    setDeletingId(tourId);
    const ok = await dbDeleteTour(tourId);
    if (ok) {
      setTours(prev => prev.filter(t => t.id !== tourId));
      setZoneCounts(prev => { const n = { ...prev }; delete n[tourId]; return n; });
      setConfirmDeleteId(null);
    } else {
      alert('Could not delete. Please try again.');
    }
    setDeletingId(null);
  };

  const handleDuplicate = async (tourId: string) => {
    setDuplicatingId(tourId);
    const newTour = await dbDuplicateTour(tourId, user.id);
    if (newTour) {
      setTours(prev => [newTour, ...prev]);
      const counts = await getZoneCountsByTourIds([newTour.id]);
      setZoneCounts(prev => ({ ...prev, ...counts }));
    } else {
      alert('Could not duplicate. Please try again.');
    }
    setDuplicatingId(null);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-zinc-950 overflow-hidden">

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/70 h-full">

        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 pt-5 pb-6">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center shrink-0">
            <MapPin size={16} className="text-zinc-950" />
          </div>
          <span className="font-bold text-white tracking-tight text-base">Obelisk</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 flex flex-col gap-0.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-600 px-3 mb-1.5">Workspace</p>
          <NavItem
            icon={<Layers size={16} />}
            label="Experiences"
            active={activeNav === 'tours'}
            onClick={() => setActiveNav('tours')}
          />
          <NavItem
            icon={<BarChart2 size={16} />}
            label="Analytics"
            disabled
            badge="Soon"
          />
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-zinc-800/70">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <span className="text-emerald-400 text-[11px] font-bold uppercase">
                {user.email[0]}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-zinc-300 truncate leading-tight font-medium">{user.email}</p>
            </div>
            <button
              onClick={onLogout}
              title="Sign out"
              className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto bg-zinc-950">
        <div className="max-w-5xl mx-auto px-8 py-8">

          {/* ── TOURS VIEW ── */}
          {activeNav === 'tours' && (
            <>
              {/* Page header */}
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-2xl font-bold text-white tracking-tight">Your Experiences</h1>
                  <p className="text-sm text-zinc-500 mt-0.5">Build and manage location-based narratives</p>
                </div>
                <button
                  onClick={createTour}
                  disabled={creating}
                  className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-zinc-950 font-bold px-4 py-2.5 rounded-xl transition-colors text-sm"
                >
                  <Plus size={16} />
                  {creating ? 'Creating…' : 'New Experience'}
                </button>
              </div>

              {createError && (
                <div className="mb-5 bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3 rounded-xl">
                  {createError}
                </div>
              )}

              {/* Stats row */}
              {tours.length > 0 && (
                <div className="grid grid-cols-3 gap-4 mb-7">
                  <StatCard
                    label="Experiences"
                    value={tours.length}
                    icon={<Layers size={18} className="text-emerald-400" />}
                    color="bg-emerald-500/10"
                  />
                  <StatCard
                    label="Total zones"
                    value={totalZones}
                    icon={<MapPin size={18} className="text-indigo-400" />}
                    color="bg-indigo-500/10"
                  />
                  <StatCard
                    label="Public"
                    value={publicCount}
                    icon={<Globe size={18} className="text-sky-400" />}
                    color="bg-sky-500/10"
                  />
                </div>
              )}

              {/* Filter / sort / search toolbar */}
              {tours.length > 0 && (
                <div className="flex items-center gap-3 mb-5">
                  {/* Search */}
                  <div className="relative flex-1 max-w-xs">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search experiences…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm rounded-xl pl-9 pr-3 py-2 focus:outline-none focus:border-zinc-600 placeholder-zinc-600"
                    />
                  </div>

                  {/* Visibility filter */}
                  <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-xl p-1">
                    {(['all', 'public', 'private'] as FilterKey[]).map(f => (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                          filter === f ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  {/* Sort */}
                  <div className="relative">
                    <SortAsc size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                    <select
                      value={sort}
                      onChange={e => setSort(e.target.value as SortKey)}
                      className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs rounded-xl pl-8 pr-7 py-2 appearance-none focus:outline-none focus:border-zinc-600 cursor-pointer"
                    >
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                      <option value="az">A → Z</option>
                      <option value="za">Z → A</option>
                    </select>
                    <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                  </div>
                </div>
              )}

              {/* Empty state */}
              {!loadingTours && tours.length === 0 && (
                <div className="flex flex-col items-center justify-center py-24 bg-zinc-900/40 rounded-2xl border border-dashed border-zinc-800">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                    <Map size={28} className="text-emerald-400" />
                  </div>
                  <h3 className="font-bold text-white text-lg mb-1">No experiences yet</h3>
                  <p className="text-zinc-500 text-sm mb-6 text-center max-w-xs">
                    Create your first location-based narrative — place zones on a map, add audio and characters.
                  </p>
                  <button
                    onClick={createTour}
                    disabled={creating}
                    className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold px-5 py-2.5 rounded-xl text-sm transition-colors disabled:opacity-60"
                  >
                    <Plus size={16} /> Create your first experience
                  </button>
                </div>
              )}

              {/* No search results */}
              {!loadingTours && tours.length > 0 && visibleTours.length === 0 && (
                <div className="text-center py-16 text-zinc-500">
                  <Search size={28} className="mx-auto mb-3 text-zinc-700" />
                  <p className="font-medium">No experiences match "{search}"</p>
                  <button onClick={() => { setSearch(''); setFilter('all'); }} className="text-sm text-emerald-400 mt-2 hover:underline">
                    Clear filters
                  </button>
                </div>
              )}

              {/* Tour grid */}
              {visibleTours.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {visibleTours.map(tour => (
                    <div
                      key={tour.id}
                      className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-zinc-700 transition-colors group"
                    >
                      {/* Cover */}
                      <div className="h-40 relative overflow-hidden bg-zinc-800">
                        {tour.welcome_image_url ? (
                          <img src={tour.welcome_image_url} alt={tour.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Map size={40} className="text-zinc-700" />
                          </div>
                        )}

                        {/* Badges */}
                        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
                          <span className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-lg backdrop-blur-sm ${
                            tour.is_public
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-zinc-700/80 text-zinc-400 border border-zinc-600/40'
                          }`}>
                            {tour.is_public ? <Globe size={9} /> : <Lock size={9} />}
                            {tour.is_public ? 'Public' : 'Private'}
                          </span>
                        </div>

                        {/* Zone count */}
                        <div className="absolute top-2.5 right-2.5">
                          <span className="flex items-center gap-1 text-[10px] font-bold bg-black/50 text-zinc-300 px-2 py-1 rounded-lg backdrop-blur-sm border border-white/10">
                            <MapPin size={9} />
                            {zoneCounts[tour.id] ?? 0} {(zoneCounts[tour.id] ?? 0) === 1 ? 'zone' : 'zones'}
                          </span>
                        </div>
                      </div>

                      {/* Content */}
                      <div className="p-4">
                        <h3 className="font-bold text-white text-base leading-tight mb-1 truncate">{tour.title}</h3>
                        <p className="text-sm text-zinc-500 line-clamp-2 mb-3 leading-snug">{tour.description}</p>
                        <div className="flex items-center gap-1 text-zinc-600 text-xs mb-3">
                          <Clock size={11} />
                          <span>{formatDate(tour.created_at)}</span>
                        </div>

                        {/* Delete confirmation */}
                        {confirmDeleteId === tour.id ? (
                          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2.5">
                            <AlertTriangle size={13} className="text-red-400 shrink-0" />
                            <span className="text-xs text-red-300 flex-1">Delete this experience?</span>
                            <button
                              onClick={() => handleDelete(tour.id)}
                              disabled={deletingId === tour.id}
                              className="text-xs font-bold text-red-400 hover:text-red-300 disabled:opacity-50 whitespace-nowrap"
                            >
                              {deletingId === tour.id ? 'Deleting…' : 'Delete'}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-xs text-zinc-500 hover:text-zinc-300"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {/* Primary: Preview */}
                            <Link
                              to={`/player/${tour.id}?preview=1`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 font-semibold transition-colors border border-emerald-500/20"
                            >
                              <Play size={14} /> Preview
                            </Link>

                            {/* Secondary actions row */}
                            <div className="flex items-center justify-between">
                              <Link
                                to={`/editor/${tour.id}`}
                                className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white font-medium transition-colors px-2 py-1.5 rounded-lg hover:bg-zinc-800"
                              >
                                <Edit2 size={14} /> Edit
                              </Link>

                              <div className="flex items-center gap-0.5">
                                {/* Share */}
                                <button
                                  onClick={() => copyPlayerLink(tour.id)}
                                  title="Share player link"
                                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200 px-2 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
                                >
                                  {copiedId === tour.id
                                    ? <><Check size={13} className="text-emerald-400" /><span className="text-emerald-400">Copied!</span></>
                                    : <><Link2 size={13} /><span>Share</span></>}
                                </button>

                                {/* Duplicate */}
                                <button
                                  onClick={() => handleDuplicate(tour.id)}
                                  disabled={duplicatingId === tour.id}
                                  title="Duplicate experience"
                                  className="p-2 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                                >
                                  {duplicatingId === tour.id
                                    ? <div className="w-3.5 h-3.5 border border-zinc-500 border-t-zinc-200 rounded-full animate-spin" />
                                    : <Copy size={13} />}
                                </button>

                                {/* Delete */}
                                <button
                                  onClick={() => setConfirmDeleteId(tour.id)}
                                  title="Delete experience"
                                  className="p-2 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── ANALYTICS VIEW (placeholder) ── */}
          {activeNav === 'analytics' && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-20 h-20 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-5">
                <BarChart2 size={32} className="text-indigo-400" />
              </div>
              <h2 className="font-bold text-white text-xl mb-2">Analytics coming soon</h2>
              <p className="text-zinc-500 text-sm max-w-sm leading-relaxed mb-6">
                When player session tracking is enabled, you'll see total plays, zone visit rates,
                average session length, and engagement heatmaps per experience.
              </p>
              <div className="grid grid-cols-3 gap-4 max-w-lg w-full opacity-40 pointer-events-none select-none">
                {['Total plays', 'Avg. session', 'Zone visits'].map(l => (
                  <div key={l} className="bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-5">
                    <p className="text-2xl font-bold text-white">—</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{l}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
};
