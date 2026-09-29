# Self-hosted deployment image for cerebro.affantorla.com — runs the Vite DEV
# server (`vite`), not `vite build && vite preview`. Only ~7 of this app's ~20
# custom /api/* proxy plugins (CCTV, TomTom, Overpass, OpenSky, FIRMS,
# AIS-live, GBFS, celestrak, rocket launches, adsbdb, terrain-heights, ...)
# implement BOTH the `configureServer` and `configurePreviewServer` Vite hooks
# — most wire only `configureServer`, which `vite preview` never calls. Under
# `vite preview` those routes silently fall through to the SPA's index.html
# (200 OK, wrong content) instead of erroring, so almost every live data feed
# quietly went dark. `vite` (the dev server) is also what the README's own
# self-hosting instructions (README.md, "Terminal / coding agent") document —
# this matches the app's intended self-host path, not a workaround.
FROM node:24-alpine

WORKDIR /app

# Puppeteer/Chromium is only used by local QA scripts, never by the running
# app — skip the download so it doesn't bloat the image or fail offline.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

# This host's Docker network has no IPv6 route, but several upstream APIs
# (e.g. Overpass mirrors overpass.kumi.systems / overpass.private.coffee) are
# dual-stack and resolve an AAAA record even though an A record also exists.
# Node's default resolver order can hand fetch() the IPv6 address first with
# no Happy-Eyeballs fallback, so requests hang/fail even though the same host
# is reachable over IPv4. Force IPv4-first resolution app-wide instead of
# enabling IPv6 on the Docker host (which would affect every other container).
ENV NODE_OPTIONS=--dns-result-order=ipv4first

CMD ["npm", "run", "dev"]
