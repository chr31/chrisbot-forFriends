# Builder: install production dependencies
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 make g++ pkg-config git \
  && rm -rf /var/lib/apt/lists/*

# Copy manifest separately for better layer caching
COPY package*.json ./

# Ensure node-gyp uses Python 3
# Avoid forcing source builds so prebuilt binaries can be used
ENV npm_config_python=/usr/bin/python3 \
    npm_config_unsafe_perm=true

# Install production dependencies only
# Prefer lockfile (npm ci). Fallback to npm install if lockfile is absent.
RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      echo "No lockfile found. Using 'npm install' for this build."; \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
  && npm cache clean --force

############################################################
# Runtime: small, only runtime libraries and app code       #
############################################################
FROM node:20-bookworm-slim

WORKDIR /app

ENV TZ=Europe/Rome
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
     tzdata ca-certificates iputils-ping curl \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone \
  && rm -rf /var/lib/apt/lists/*

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Bundle app source
COPY . .

RUN mkdir -p /app/runtime/routines
RUN chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as non-root
USER node

CMD ["node", "server.js"]
