import React from 'react';
import { logClientEvent } from '../services/telemetry';

interface Props  { children: React.ReactNode; }
interface State  { hasError: boolean; }

/**
 * Catches uncaught render/lifecycle errors anywhere in the subtree and shows
 * a graceful recovery screen instead of a blank white page.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Obelisk] Uncaught error:', error.message, info.componentStack);
    logClientEvent('render_crash', error.message, {
      stack: (info.componentStack || '').slice(0, 800),
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-zinc-950 px-6 text-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 className="text-white font-bold text-lg">Something went wrong</h2>
        <p className="text-zinc-500 text-sm max-w-xs leading-relaxed">
          An unexpected error occurred. Refresh the page to continue your experience.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-1 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-semibold text-sm transition-colors"
        >
          Refresh page
        </button>
      </div>
    );
  }
}
