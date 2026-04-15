# Multi-stage build for Next.js production
FROM node:20-alpine AS deps
WORKDIR /app
# Install OS deps if needed for some npm packages
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Ensure Next binds to all interfaces in container
ENV HOSTNAME=0.0.0.0
ENV PORT=3001

# Copy runtime artifacts (non-standalone)
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

EXPOSE 3001
CMD ["npm", "run", "start"]
