import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getToursByUser, createTour as dbCreateTour, deleteTour as dbDeleteTour } from '../services/db';
import { Tour, User } from '../types';
import { Plus, Play, Edit, Map, Link2, Check, Trash2, AlertTriangle } from 'lucide-react';

interface DashboardProps {
  user: User;
}

export const Dashboard: React.FC<DashboardProps> = ({ user }) => {
  const [tours, setTours] = useState<Tour[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => { loadTours(); }, []);

  const loadTours = async () => {
    const data = await getToursByUser(user.id);
    setTours(data);
  };

  const createTour = async () => {
    setCreating(true);
    setCreateError(null);
    const tour = await dbCreateTour({
      owner_id: user.id,
      title: 'New Untitled Tour',
      description: 'Description of your new sound walk.',
      is_public: true,
      lat: 40.7484,
      lng: -73.9856,
    });
    setCreating(false);
    if (tour) {
      navigate(`/editor/${tour.id}`);
    } else {
      setCreateError('Failed to create tour. Check the browser console for details.');
    }
  };

  const copyPlayerLink = (tourId: string) => {
    const url = `${window.location.origin}/player/${tourId}`;
    if (navigator.share) {
      navigator.share({ title: 'Join my Obelisk tour', url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setCopiedId(tourId);
        setTimeout(() => setCopiedId(null), 2000);
      });
    }
  };

  const handleDeleteTour = async (tourId: string) => {
    setDeletingId(tourId);
    await dbDeleteTour(tourId);
    setTours(prev => prev.filter(t => t.id !== tourId));
    setConfirmDeleteId(null);
    setDeletingId(null);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-auto">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-3xl font-bold text-slate-800">Your Tours</h1>
        <button
          onClick={createTour}
          disabled={creating}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white px-4 py-2 rounded-lg transition-colors"
        >
          <Plus size={18} />
          <span>{creating ? 'Creating…' : 'New Tour'}</span>
        </button>
      </div>

      {createError && (
        <div className="mb-6 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
          {createError}
        </div>
      )}

      {tours.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-dashed border-gray-300">
          <Map className="mx-auto h-12 w-12 text-gray-300 mb-4" />
          <p className="text-slate-500">You haven't created any tours yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tours.map((tour) => (
            <div key={tour.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
              {/* Cover image */}
              <div className="h-40 bg-slate-100 relative overflow-hidden">
                {tour.welcome_image_url ? (
                  <img src={tour.welcome_image_url} alt={tour.title} className="w-full h-full object-cover" />
                ) : (
                  <>
                    <div className="absolute inset-0 bg-emerald-50 opacity-50" />
                    <Map className="text-emerald-200 w-16 h-16 absolute inset-0 m-auto" />
                  </>
                )}
              </div>

              <div className="p-5">
                <h3 className="font-bold text-lg text-slate-800 mb-1">{tour.title}</h3>
                <p className="text-sm text-slate-500 mb-4 line-clamp-2">{tour.description}</p>

                {/* Delete confirmation inline */}
                {confirmDeleteId === tour.id ? (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
                    <AlertTriangle size={14} className="text-red-500 shrink-0" />
                    <span className="text-xs text-red-700 flex-1">Delete this tour?</span>
                    <button
                      onClick={() => handleDeleteTour(tour.id)}
                      disabled={deletingId === tour.id}
                      className="text-xs font-bold text-red-600 hover:text-red-800 disabled:opacity-50"
                    >
                      {deletingId === tour.id ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between mt-4">
                    {/* Left: Edit + Delete */}
                    <div className="flex items-center gap-3">
                      <Link
                        to={`/editor/${tour.id}`}
                        className="flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-600 font-medium"
                      >
                        <Edit size={16} /> Edit
                      </Link>
                      <button
                        onClick={() => setConfirmDeleteId(tour.id)}
                        title="Delete tour"
                        className="text-slate-300 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>

                    {/* Right: Share + Play */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => copyPlayerLink(tour.id)}
                        title="Copy player link"
                        className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-700 transition-colors"
                      >
                        {copiedId === tour.id
                          ? <><Check size={15} className="text-emerald-500" /><span className="text-emerald-600 text-xs font-medium">Copied!</span></>
                          : <Link2 size={15} />}
                      </button>
                      <Link
                        to={`/player/${tour.id}`}
                        className="flex items-center gap-1 text-sm bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-full hover:bg-emerald-200 font-medium transition-colors"
                      >
                        <Play size={16} /> Play
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
