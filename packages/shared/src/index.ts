export * from './states';
export * from './schemas';
export * from './api';
export * from './url';
export * from './text';
export * from './matching';
export * from './questions';
export * from './profile';
export * from './normalize';
export { classifyLiveness, BOT_CHALLENGE_PATTERNS } from './vendor/liveness-core';
export type { LivenessInput, LivenessResult } from './vendor/liveness-core';
export * from './discovery';

/** Version of the ApplyFlux Agent extension this server ships (kept equal to apps/extension/package.json by a test). */
export const EXTENSION_VERSION = '0.3.1';
