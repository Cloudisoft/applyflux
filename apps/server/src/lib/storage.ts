import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config';

export interface StorageDriver {
  put(path: string, bytes: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<Buffer>;
  remove(paths: string[]): Promise<void>;
}

class SupabaseStorage implements StorageDriver {
  constructor(
    private client: SupabaseClient,
    private bucket: string,
  ) {}
  async put(path: string, bytes: Buffer, contentType: string) {
    const { error } = await this.client.storage.from(this.bucket).upload(path, bytes, { contentType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }
  async get(path: string) {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? 'no data'}`);
    return Buffer.from(await data.arrayBuffer());
  }
  async remove(paths: string[]) {
    if (!paths.length) return;
    const { error } = await this.client.storage.from(this.bucket).remove(paths);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }
}

/** Test-only driver (refused in production by config validation). */
export class MemoryStorage implements StorageDriver {
  files = new Map<string, Buffer>();
  async put(path: string, bytes: Buffer) {
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, bytes);
  }
  async get(path: string) {
    const b = this.files.get(path);
    if (!b) throw new Error('not found');
    return b;
  }
  async remove(paths: string[]) {
    paths.forEach((p) => this.files.delete(p));
  }
}

export function createStorage(config: Config): StorageDriver {
  if (config.STORAGE_DRIVER === 'memory') return new MemoryStorage();
  const client = createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  return new SupabaseStorage(client, config.STORAGE_BUCKET);
}

export function supabaseAdmin(config: Config): SupabaseClient | null {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
