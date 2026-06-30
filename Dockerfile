# Dockerfile — Wave 5 / P8 Step 5. Single image used for both the BFF and the
# (statically built) frontend; docker-compose overrides the command per service.
#
# Note: tsx/vite/typescript are devDependencies, so we install the FULL dependency
# set (the BFF runs TypeScript directly via tsx — no separate compile step). A
# slimmer production image (compile bff -> JS, prune dev deps, serve the frontend
# via nginx) is a later optimization; this is "prod-ready in code", not size-tuned.
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS app
WORKDIR /app

# Frontend bakes its BFF URL at build time (Vite env is compile-time).
ARG VITE_BFF_URL=http://localhost:8787
ENV VITE_BFF_URL=$VITE_BFF_URL

# Install all deps first (better layer caching). --include=dev guards against a
# globally-set NODE_ENV=production that would otherwise drop tsx/vite.
COPY package*.json ./
RUN npm ci --include=dev --no-audit --no-fund

# App source + frontend build (produces dist/).
COPY . .
RUN npm run build

EXPOSE 8787 4173
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default: run the BFF. The `web` service in docker-compose overrides this.
CMD ["npm", "run", "start:bff"]
