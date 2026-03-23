# ============================================
# Stage 1: Build
# ============================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY scripts/ scripts/

# Type check and build
RUN npm run typecheck && npm run build

# Compile migration files to JS (they are dynamically imported at runtime, not bundled by tsup)
RUN npx tsup src/db/migrations/*.ts --outDir dist/migrations --format esm --target node22 --no-splitting --external kysely --no-dts

# Remove dev dependencies
RUN npm prune --omit=dev

# ============================================
# Stage 2: Production
# ============================================
FROM node:22-alpine AS runner

RUN apk add --no-cache wget
COPY certs/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

# Run as non-root user
RUN addgroup -g 1001 -S tenant-manager && \
    adduser -S tenant-manager -u 1001 -G tenant-manager

WORKDIR /app

# Copy production dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy built output (includes dist/migrations/ compiled by tsup)
COPY --from=builder /app/dist ./dist

USER tenant-manager

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health/live || exit 1

CMD ["node", "dist/index.js"]
