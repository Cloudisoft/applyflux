import * as React from 'react';
import { buttonVariants } from '@/components/ui';

/** Keeps a rendering bug on one screen from blanking the whole app. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ApplyFlux] render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid min-h-[60vh] place-items-center px-4 text-center">
        <div>
          <h1 className="text-2xl font-bold">Something went wrong on this page</h1>
          <p className="mt-2 text-muted">Your data is safe. Reloading usually fixes it.</p>
          <button type="button" onClick={() => window.location.reload()} className={`${buttonVariants()} mt-6`}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
