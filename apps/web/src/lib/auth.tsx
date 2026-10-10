import * as React from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface AuthState {
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = React.createContext<AuthState>({ session: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  const value = React.useMemo(
    () => ({
      session,
      loading,
      signOut: async () => {
        // Sign out everywhere when the server is reachable; otherwise still sign out on this device.
        try {
          const { error } = await supabase.auth.signOut();
          if (error) throw error;
        } catch {
          await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
          for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) localStorage.removeItem(k);
        }
        queryClientRef?.clear();
        setSession(null);
      },
    }),
    [session, loading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => React.useContext(Ctx);

/** Cached data from the previous account must not survive a sign-out. */
let queryClientRef: { clear: () => void } | null = null;
export function registerQueryClient(qc: { clear: () => void }) {
  queryClientRef = qc;
}
