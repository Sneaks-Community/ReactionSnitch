# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: Runtime environment
FROM node:24-alpine AS runtime

WORKDIR /app

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source and package files
COPY --from=deps /app/package.json ./package.json
COPY index.js ./index.js
COPY healthcheck.js ./healthcheck.js

# Create non-root system user for security
RUN addgroup --system --gid 1001 appuser && \
    adduser --system --uid 1001 appuser && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Set production environment
ENV NODE_ENV=production

# Add OCI image labels
LABEL org.opencontainers.image.title="ReactionSnitch"
LABEL org.opencontainers.image.description="A Discord bot that posts notifications when someone reacts to a message"
LABEL org.opencontainers.image.source="https://github.com/Sneaks-Community/ReactionSnitch"
LABEL org.opencontainers.image.version="3.1.1"
LABEL org.opencontainers.image.authors="Sneak's Community"

# Healthcheck: ping the bot's health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "index.js"]
