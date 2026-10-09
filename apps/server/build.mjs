// Bundles the API (and the workspace packages it imports) into dist/ for production.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts', 'src/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Workspace packages (@applyflux/*) are TypeScript sources and get bundled in; npm dependencies stay external.
  external: ['pg', 'express', 'unpdf', 'mammoth', 'pdf-lib', '@supabase/supabase-js', '@anthropic-ai/sdk', 'jose', 'multer', 'helmet', 'cors', 'express-rate-limit', 'zod'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built dist/');
