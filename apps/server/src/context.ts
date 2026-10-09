import type { SupabaseClient } from '@supabase/supabase-js';
import type { JWTPayload } from 'jose';
import type { AiClient } from './ai/provider';
import type { Config } from './config';
import type { Db } from './db';
import type { FetchJson } from './services/discovery';
import type { StorageDriver } from './lib/storage';

export interface AppContext {
  config: Config;
  db: Db;
  storage: StorageDriver;
  ai: AiClient;
  verifyJwt: (token: string) => Promise<JWTPayload>;
  fetchJson: FetchJson;
  /** Admin client for auth.admin.deleteUser on account deletion; null when not configured (tests). */
  supabaseAdmin: SupabaseClient | null;
}
