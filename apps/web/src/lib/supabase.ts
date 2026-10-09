import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when the deployment has Supabase configured. The UI explains what to set when it is not. */
export const supabaseConfigured = !!url && !!anon;

export const supabase: SupabaseClient = createClient(url || 'http://localhost:54321', anon || 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  realtime: { params: { eventsPerSecond: 5 } },
});
