# Production image for Railway. Base images come from AWS's public mirror of the official
# Docker images, so builds don't depend on Docker Hub's pull rate limits.
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Build-time settings (Railway passes service variables as build args when they are declared here).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_URL
ARG VITE_EXTENSION_ID
ARG VITE_EXTENSION_STORE_URL
ARG APPLYFLUX_EXTENSION_KEY
ARG APPLYFLUX_API_URL
ARG APPLYFLUX_WEB_URL
ARG RAILWAY_PUBLIC_DOMAIN

COPY . .
RUN pnpm install --frozen-lockfile --prod=false
RUN NODE_ENV=production pnpm build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "start"]
