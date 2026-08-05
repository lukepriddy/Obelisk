import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  getToursByUser,
  createTour as dbCreateTour,
  deleteTour as dbDeleteTour,
  getZoneCountsByTourIds,
  getZonesByTourId,
  duplicateTour as dbDuplicateTour,
  getAnalyticsByTourIds,
  getApiKeys,
  saveApiKeys,
} from '../services/db';
import { Tour, User, TourAnalytics } from '../types';
import {
  Plus, Play, Edit2, Map, Link2, Check, Trash2, AlertTriangle,
  MapPin, LogOut, BarChart2, Globe, Lock, Copy, Search,
  ChevronDown, Layers, Clock, SortAsc, TrendingUp, Users, Timer,
  ChevronRight, Sparkles, Settings, KeyRound, Eye, EyeOff, Loader2,
  Tag as TagIcon,
} from 'lucide-react';
import { GenerateExperienceModal } from '../components/GenerateExperienceModal';

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

// ── API key row (Settings) ──────────────────────────────────────────────────
const ApiKeyRow: React.FC<{
  label: string;
  blurb: string;
  placeholder: string;
  saved: boolean;
  onSave: (value: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}> = ({ label, blurb, placeholder, saved, onSave, onRemove }) => {
  const [value, setValue]     = useState('');
  const [show, setShow]       = useState(false);
  const [busy, setBusy]       = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setMessage(null);
    const ok = await onSave(value.trim());
    setBusy(false);
    if (ok) { setValue(''); setShow(false); setMessage('Key saved.'); }
    else setMessage('Failed to save — please try again.');
  };

  const remove = async () => {
    setBusy(true);
    setMessage(null);
    const ok = await onRemove();
    setBusy(false);
    setMessage(ok ? 'Key removed.' : 'Failed to remove — please try again.');
  };

  return (
    <div className="border-t border-zinc-800 pt-4">
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-bold text-zinc-300 uppercase tracking-wider">{label}</label>
        {saved && (
          <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 rounded-full">
            <Check size={9} /> Key saved
          </span>
        )}
      </div>
      <p className="text-[11px] text-zinc-600 mb-3">{blurb}</p>

      <div className="flex gap-2">
        <div className="flex items-center gap-2 flex-1 bg-zinc-800 border border-zinc-700 focus-within:border-zinc-500 rounded-xl px-3 transition-colors">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={saved ? 'Enter a new key to replace the saved one' : placeholder}
            className="flex-1 bg-transparent text-sm text-zinc-200 py-2.5 placeholder-zinc-600 focus:outline-none"
            autoComplete="off"
          />
          <button
            onClick={() => setShow(v => !v)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label={show ? 'Hide key' : 'Show key'}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          onClick={save}
          disabled={!value.trim() || busy}
          className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-sm font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </button>
      </div>

      {saved && (
        <button
          onClick={remove}
          disabled={busy}
          className="text-[11px] text-zinc-600 hover:text-red-400 mt-2 transition-colors disabled:opacity-40"
        >
          Remove saved key
        </button>
      )}

      {message && (
        <p className={`text-xs mt-2 ${message.includes('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>
          {message}
        </p>
      )}
    </div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({ user, onLogout }) => {
  const [tours, setTours]             = useState<Tour[]>([]);
  const [zoneCounts, setZoneCounts]   = useState<Record<string, number>>({});
  const [analytics, setAnalytics]     = useState<Record<string, TourAnalytics>>({});
  const [expandedAnalytics, setExpandedAnalytics] = useState<string | null>(null);
  const [creating, setCreating]       = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedId, setCopiedId]       = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId]   = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [activeNav, setActiveNav]     = useState<'tours' | 'analytics' | 'settings'>('tours');
  const [search, setSearch]           = useState('');
  const [sort, setSort]               = useState<SortKey>('newest');
  const [filter, setFilter]           = useState<FilterKey>('all');
  const [tagFilter, setTagFilter]     = useState<string>('all');
  const [loadingTours, setLoadingTours] = useState(true);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  // Settings — which provider keys exist in the DB
  const [keysSaved, setKeysSaved] = useState<{ elevenlabs: boolean; gemini: boolean }>({ elevenlabs: false, gemini: false });
  // zone_id → title, loaded lazily when a tour row is expanded in analytics
  const [zoneNames, setZoneNames]       = useState<Record<string, string>>({});

  const navigate = useNavigate();

  // When a tour row is expanded in analytics, fetch its zone titles once
  useEffect(() => {
    if (!expandedAnalytics) return;
    const a = analytics[expandedAnalytics];
    if (!a || !a.zone_visits.length) return;
    // Only fetch if any zone in this tour is still unknown
    const missing = a.zone_visits.some(({ zone_id }) => !(zone_id in zoneNames));
    if (!missing) return;
    getZonesByTourId(expandedAnalytics).then(zones => {
      setZoneNames(prev => {
        const next = { ...prev };
        zones.forEach(z => { next[z.id] = z.title; });
        return next;
      });
    });
  }, [expandedAnalytics]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadTours(); }, []);

  // Load saved API keys when Settings is opened
  useEffect(() => {
    if (activeNav !== 'settings') return;
    getApiKeys(user.id).then(keys => {
      setKeysSaved({ elevenlabs: !!keys?.elevenlabs_key, gemini: !!keys?.gemini_key });
    });
  }, [activeNav]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveProviderKey = async (provider: 'elevenlabs' | 'gemini', value: string | null): Promise<boolean> => {
    const column = provider === 'elevenlabs' ? 'elevenlabs_key' : 'gemini_key';
    const ok = await saveApiKeys(user.id, { [column]: value });
    if (ok) setKeysSaved(prev => ({ ...prev, [provider]: value !== null }));
    return ok;
  };

  const loadTours = async () => {
    setLoadingTours(true);
    const data = await getToursByUser(user.id);
    setTours(data);
    if (data.length) {
      const ids = data.map(t => t.id);
      const [counts, analyticsData] = await Promise.all([
        getZoneCountsByTourIds(ids),
        getAnalyticsByTourIds(ids),
      ]);
      setZoneCounts(counts);
      setAnalytics(analyticsData);
    }
    setLoadingTours(false);
  };

  // ── Derived stats ────────────────────────────────────────────────────────
  const totalZones  = Object.values(zoneCounts).reduce((s, c) => s + c, 0);
  const publicCount = tours.filter(t => t.is_public).length;
  const allTags = React.useMemo(
    () => Array.from(new Set(tours.flatMap(t => t.tags || []))).sort((a, b) => a.localeCompare(b)),
    [tours],
  );

  // ── Filtered + sorted tour list ──────────────────────────────────────────
  const visibleTours = useMemo(() => {
    let list = [...tours];
    if (filter === 'public')  list = list.filter(t => t.is_public);
    if (filter === 'private') list = list.filter(t => !t.is_public);
    if (tagFilter !== 'all') list = list.filter(t => (t.tags || []).includes(tagFilter));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.tags || []).some(tag => tag.toLowerCase().includes(q))
      );
    }
    list.sort((a, b) => {
      if (sort === 'newest') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sort === 'oldest') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (sort === 'az') return a.title.localeCompare(b.title);
      if (sort === 'za') return b.title.localeCompare(a.title);
      return 0;
    });
    return list;
  }, [tours, filter, tagFilter, search, sort]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const createTour = async () => {
    setCreating(true);
    setCreateError(null);
    const tour = await dbCreateTour({
      owner_id: user.id,
      title: 'Untitled Experience',
      description: 'Describe your experience here.',
      is_public: false,
      lat: 0,
      lng: 0,
      map_style: 'satellite',
    });
    setCreating(false);
    if (tour) navigate(`/editor/${tour.id}`);
    else setCreateError('Failed to create. Check your connection and try again.');
  };

  const copyPlayerLink = (tourId: string) => {
    // Vercel preview/deployment URLs can sit behind Deployment Protection.
    // Share the public production alias from any vercel.app host; custom
    // domains and local development keep their current origin.
    const host = window.location.hostname;
    const origin = host.endsWith('.vercel.app')
      ? 'https://obelisk-main.vercel.app'
      : window.location.origin;
    const url = `${origin}/player/${tourId}?v=${Date.now().toString(36)}`;
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
    const { ok, error } = await dbDeleteTour(tourId);
    if (ok) {
      setTours(prev => prev.filter(t => t.id !== tourId));
      setZoneCounts(prev => { const n = { ...prev }; delete n[tourId]; return n; });
      setConfirmDeleteId(null);
    } else {
      // Prefer the server's message: it distinguishes "nothing was removed,
      // retry" from "files went but the row didn't", which matter differently.
      alert(error ?? 'Could not delete. Please try again.');
    }
    setDeletingId(null);
  };

  const handleDuplicate = async (tourId: string) => {
    setDuplicatingId(tourId);
    const newTour = await dbDuplicateTour(tourId, user.id);
    if (newTour) {
      setTours(prev => [newTour, ...prev]);
      const [counts, analyticsData] = await Promise.all([
        getZoneCountsByTourIds([newTour.id]),
        getAnalyticsByTourIds([newTour.id]),
      ]);
      setZoneCounts(prev => ({ ...prev, ...counts }));
      setAnalytics(prev => ({ ...prev, ...analyticsData }));
    } else {
      alert('Could not duplicate. Please try again.');
    }
    setDuplicatingId(null);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatRelative = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins  <  2) return 'just now';
    if (mins  < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days  <  7) return `${days}d ago`;
    return formatDate(iso);
  };

  const formatDuration = (secs: number | null) => {
    if (secs === null) return '—';
    if (secs < 60) return `${Math.round(secs)}s`;
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-dvh bg-zinc-950 overflow-hidden">

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col bg-zinc-950 border-r border-zinc-800/70 h-full">

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
            active={activeNav === 'analytics'}
            onClick={() => setActiveNav('analytics')}
          />
          <NavItem
            icon={<Settings size={16} />}
            label="Settings"
            active={activeNav === 'settings'}
            onClick={() => setActiveNav('settings')}
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
        <div className="max-w-5xl mx-auto px-4 py-5 pb-24 md:px-8 md:py-8 md:pb-8">

          {/* ── TOURS VIEW ── */}
          {activeNav === 'tours' && (
            <>
              {/* Page header */}
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-6">
                <div className="min-w-0">
                  <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight">Your Experiences</h1>
                  <p className="hidden sm:block text-sm text-zinc-500 mt-0.5">Build and manage location-based narratives</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setShowGenerateModal(true)}
                    className="flex items-center gap-2 bg-transparent border border-indigo-500/50 hover:border-indigo-400 hover:bg-indigo-500/10 text-indigo-300 hover:text-indigo-200 font-semibold px-4 py-2.5 rounded-xl transition-colors text-sm"
                  >
                    <Sparkles size={15} />
                    Generate with AI
                  </button>
                  <button
                    onClick={createTour}
                    disabled={creating}
                    className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-zinc-950 font-bold px-4 py-2.5 rounded-xl transition-colors text-sm"
                  >
                    <Plus size={16} />
                    {creating ? 'Creating…' : 'New Experience'}
                  </button>
                </div>
              </div>

              {createError && (
                <div className="mb-5 bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3 rounded-xl">
                  {createError}
                </div>
              )}

              {/* Stats row */}
              {tours.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-7">
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

                  {/* Tag filter — the closest thing to folders */}
                  {allTags.length > 0 && (
                    <div className="relative">
                      <TagIcon size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                      <select
                        value={tagFilter}
                        onChange={e => setTagFilter(e.target.value)}
                        className={`bg-zinc-900 border text-xs rounded-xl pl-8 pr-7 py-2 appearance-none focus:outline-none cursor-pointer ${
                          tagFilter === 'all'
                            ? 'border-zinc-800 text-zinc-300 focus:border-zinc-600'
                            : 'border-emerald-600/60 text-emerald-300'
                        }`}
                      >
                        <option value="all">All tags</option>
                        {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                      </select>
                      <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                    </div>
                  )}
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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {visibleTours.map(tour => (
                    <div
                      key={tour.id}
                      className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-zinc-700 transition-colors group flex flex-col h-full"
                    >
                      {/* Cover */}
                      <div className="aspect-square relative overflow-hidden bg-zinc-950">
                        {tour.welcome_image_url ? (
                          <img src={tour.welcome_image_url} alt={tour.title} className="w-full h-full object-contain group-hover:scale-[1.02] transition-transform duration-500" />
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

                        {/* Zone count + play count */}
                        <div className="absolute top-2.5 right-2.5 flex flex-col items-end gap-1">
                          <span className="flex items-center gap-1 text-[10px] font-bold bg-black/50 text-zinc-300 px-2 py-1 rounded-lg backdrop-blur-sm border border-white/10">
                            <MapPin size={9} />
                            {zoneCounts[tour.id] ?? 0} {(zoneCounts[tour.id] ?? 0) === 1 ? 'zone' : 'zones'}
                          </span>
                          {(analytics[tour.id]?.total_plays ?? 0) > 0 && (
                            <span className="flex items-center gap-1 text-[10px] font-bold bg-black/50 text-indigo-300 px-2 py-1 rounded-lg backdrop-blur-sm border border-white/10">
                              <TrendingUp size={9} />
                              {analytics[tour.id].total_plays} {analytics[tour.id].total_plays === 1 ? 'play' : 'plays'}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Content. Column layout with the action block pushed to
                          the bottom, so Preview and Edit line up across the row
                          even when a card has no tags to fill the space. */}
                      <div className="p-4 flex flex-col flex-1">
                        <h3 className="font-bold text-white text-base leading-tight mb-1.5 truncate">{tour.title}</h3>
                        <div className="flex items-center gap-1 text-zinc-600 text-xs mb-3">
                          <Clock size={11} />
                          <span>{formatDate(tour.created_at)}</span>
                        </div>
                        {(tour.tags || []).length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-3">
                            {(tour.tags || []).map(tag => (
                              <button
                                key={tag}
                                onClick={() => setTagFilter(tag)}
                                className="px-2 py-0.5 rounded-md bg-zinc-800 hover:bg-emerald-600/25 text-[10px] font-medium text-zinc-400 hover:text-emerald-300 transition-colors"
                              >
                                {tag}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Delete confirmation */}
                        {confirmDeleteId === tour.id ? (
                          <div className="mt-auto flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2.5">
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
                          <div className="mt-auto flex flex-col gap-2">
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

          {/* ── ANALYTICS VIEW ── */}
          {activeNav === 'analytics' && (() => {
            const totalPlays     = Object.values(analytics).reduce((s, a) => s + a.total_plays, 0);
            const totalVisits    = Object.values(analytics).reduce((s, a) => s + a.zone_visits.reduce((sv, v) => sv + v.visit_count, 0), 0);
            const allLastPlayed  = Object.values(analytics).map(a => a.last_played).filter(Boolean) as string[];
            const latestPlay     = allLastPlayed.length
              ? allLastPlayed.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
              : null;

            return (
              <>
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">Analytics</h1>
                    <p className="text-sm text-zinc-500 mt-0.5">Real plays from the player URL — preview sessions excluded</p>
                  </div>
                </div>

                {/* Global stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-7">
                  <StatCard label="Total plays" value={totalPlays} icon={<TrendingUp size={18} className="text-indigo-400" />} color="bg-indigo-500/10" />
                  <StatCard label="Zone visits" value={totalVisits} icon={<MapPin size={18} className="text-emerald-400" />} color="bg-emerald-500/10" />
                  <StatCard label="Last activity" value={latestPlay ? formatRelative(latestPlay) : '—'} icon={<Timer size={18} className="text-amber-400" />} color="bg-amber-500/10" />
                </div>

                {/* No data yet */}
                {totalPlays === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 bg-zinc-900/40 rounded-2xl border border-dashed border-zinc-800">
                    <BarChart2 size={32} className="text-zinc-700 mb-3" />
                    <p className="font-semibold text-zinc-400 mb-1">No plays yet</p>
                    <p className="text-sm text-zinc-600 max-w-xs text-center">
                      Share a player link with real visitors. Data appears here as soon as someone taps "Begin Experience".
                    </p>
                  </div>
                )}

                {/* Per-tour breakdown */}
                {tours.length > 0 && totalPlays > 0 && (
                  <div className="flex flex-col gap-3">
                    {tours.map(tour => {
                      const a = analytics[tour.id];
                      if (!a) return null;
                      const isExpanded = expandedAnalytics === tour.id;

                      return (
                        <div key={tour.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                          {/* Row */}
                          <button
                            onClick={() => setExpandedAnalytics(isExpanded ? null : tour.id)}
                            className="w-full flex items-center gap-4 px-5 py-4 hover:bg-zinc-800/50 transition-colors text-left"
                          >
                            {/* Cover thumb */}
                            <div className="w-10 h-10 rounded-xl bg-zinc-800 shrink-0 overflow-hidden border border-zinc-700">
                              {tour.welcome_image_url
                                ? <img src={tour.welcome_image_url} alt="" className="w-full h-full object-contain" />
                                : <Map size={18} className="text-zinc-600 m-auto mt-2.5" />}
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-white text-sm truncate">{tour.title}</p>
                              <p className="text-xs text-zinc-500 mt-0.5">
                                {a.last_played ? `Last played ${formatRelative(a.last_played)}` : 'Never played'}
                              </p>
                            </div>

                            {/* Stats */}
                            <div className="flex items-center gap-6 shrink-0">
                              <div className="text-center hidden sm:block">
                                <p className="text-lg font-bold text-white leading-none">{a.total_plays}</p>
                                <p className="text-[10px] text-zinc-500 mt-0.5">plays</p>
                              </div>
                              <div className="text-center hidden sm:block">
                                <p className="text-lg font-bold text-white leading-none">
                                  {a.zone_visits.reduce((s, v) => s + v.visit_count, 0)}
                                </p>
                                <p className="text-[10px] text-zinc-500 mt-0.5">zone visits</p>
                              </div>
                              <div className="text-center hidden md:block">
                                <p className="text-lg font-bold text-white leading-none">{formatDuration(a.avg_duration_seconds)}</p>
                                <p className="text-[10px] text-zinc-500 mt-0.5">avg session</p>
                              </div>
                              <ChevronRight
                                size={16}
                                className={`text-zinc-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              />
                            </div>
                          </button>

                          {/* Zone breakdown (expanded) */}
                          {isExpanded && (
                            <div className="border-t border-zinc-800 px-5 py-4">
                              <p className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-3">Zone visits</p>
                              {a.zone_visits.length === 0 ? (
                                <p className="text-sm text-zinc-600">No zone visits recorded yet.</p>
                              ) : (
                                <div className="flex flex-col gap-2">
                                  {a.zone_visits.map(({ zone_id, visit_count }) => {
                                    const maxCount = a.zone_visits[0]?.visit_count ?? 1;
                                    const pct = Math.round((visit_count / maxCount) * 100);
                                    const label = zoneNames[zone_id] ?? zone_id.slice(0, 8) + '…';
                                    return (
                                      <div key={zone_id} className="flex items-center gap-3">
                                        <span className="text-xs text-zinc-400 w-32 truncate shrink-0">{label}</span>
                                        <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                          <div
                                            className="h-full bg-indigo-500 rounded-full transition-all"
                                            style={{ width: `${pct}%` }}
                                          />
                                        </div>
                                        <span className="text-xs font-bold text-zinc-300 w-6 text-right shrink-0">{visit_count}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}

          {/* ── SETTINGS VIEW ── */}
          {activeNav === 'settings' && (
            <>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-2xl font-bold text-white tracking-tight">Settings</h1>
                  <p className="text-sm text-zinc-500 mt-0.5">API keys and account preferences</p>
                </div>
              </div>

              {/* API Keys card */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-xl">
                <div className="flex items-center gap-2.5 mb-1">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
                    <KeyRound size={14} className="text-amber-400" />
                  </div>
                  <h2 className="font-bold text-white text-sm">API Keys</h2>
                </div>
                <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
                  Your keys are stored securely and only used server-side — they never reach players' browsers.
                  Usage is billed to your own provider accounts.
                </p>

                {/* Google Gemini */}
                <ApiKeyRow
                  label="Google Gemini"
                  blurb="Powers character conversations, character voices, and the AI experience generator. Get a key at aistudio.google.com/apikey."
                  placeholder="AIza…"
                  saved={keysSaved.gemini}
                  onSave={v => saveProviderKey('gemini', v)}
                  onRemove={() => saveProviderKey('gemini', null)}
                />

                {/* ElevenLabs */}
                <ApiKeyRow
                  label="ElevenLabs"
                  blurb="Powers AI voiceover generation in audio zones. Get a key at elevenlabs.io → Profile → API Keys."
                  placeholder="sk_…"
                  saved={keysSaved.elevenlabs}
                  onSave={v => saveProviderKey('elevenlabs', v)}
                  onRemove={() => saveProviderKey('elevenlabs', null)}
                />
              </div>
            </>
          )}

        </div>
      </main>

      {/* ── MOBILE TAB BAR — the sidebar is desktop-only, so its nav lives here.
             Also carries sign-out, which was otherwise stranded in the sidebar. */}
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-50 flex items-stretch border-t border-zinc-800 bg-zinc-950/95 backdrop-blur"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {([
          { key: 'tours', label: 'Experiences', icon: <Layers size={18} /> },
          { key: 'analytics', label: 'Analytics', icon: <BarChart2 size={18} /> },
          { key: 'settings', label: 'Settings', icon: <Settings size={18} /> },
        ] as const).map(item => (
          <button
            key={item.key}
            onClick={() => setActiveNav(item.key)}
            className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-[10px] font-bold transition-colors ${
              activeNav === item.key ? 'text-emerald-400' : 'text-zinc-500'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        <button
          onClick={onLogout}
          className="flex-1 flex flex-col items-center gap-1 py-2.5 text-[10px] font-bold text-zinc-500"
        >
          <LogOut size={18} />
          Sign out
        </button>
      </nav>

      {/* ── GENERATE EXPERIENCE MODAL ───────────────────────────────────────── */}
      {showGenerateModal && (
        <GenerateExperienceModal
          userId={user.id}
          onClose={() => setShowGenerateModal(false)}
          onBuilt={(tourId) => {
            setShowGenerateModal(false);
            navigate(`/editor/${tourId}`);
            loadTours();
          }}
        />
      )}
    </div>
  );
};
