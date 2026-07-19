# syntax=docker/dockerfile:1

# --- deps: install dependencies (compiles better-sqlite3's native addon) ---
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@latest --activate \
  && pnpm install --frozen-lockfile

# --- builder: compile the Next.js standalone server bundle ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && corepack prepare pnpm@latest --activate \
  && pnpm build

# --- runner: minimal runtime image ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# SQLite file lives on the /data volume — override to change its location.
ENV DATABASE_PATH=/data/budget.db

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 budget \
  && mkdir -p /data \
  && chown budget:nodejs /data

# Next.js standalone output: a self-contained server with only the traced
# production dependencies (including better-sqlite3, kept external — see
# next.config.ts — and copied in as a native addon).
COPY --from=builder --chown=budget:nodejs /app/.next/standalone ./
COPY --from=builder --chown=budget:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=budget:nodejs /app/public ./public
# Raw SQL migrations — not traced by Next's build, applied at startup by
# src/db/index.ts to bootstrap a brand-new /data/budget.db.
COPY --from=builder --chown=budget:nodejs /app/drizzle ./drizzle

USER budget

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
