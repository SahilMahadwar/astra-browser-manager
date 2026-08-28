# AstraBrowser Manager image: Node/Hono backend + React frontend + KasmVNC.
#
# The apt packages below are Chromium/KasmVNC requirements and have nothing to
# do with the backend language. The predecessor Python image is kept for
# reference in archive/python-backend/ — see that directory's README.

# Stage 1: Build React frontend
FROM node:24-slim AS frontend-builder
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build the TypeScript backend
FROM node:24-slim AS server-builder
WORKDIR /build
COPY server/package.json server/package-lock.json ./
# --ignore-scripts is load-bearing, not a hardening flourish. camoufox-js depends
# on better-sqlite3, which carries a binding.gyp, so npm runs `node-gyp rebuild`
# on it implicitly — and this image deliberately has no Python or compiler. The
# rebuild is pointless anyway: better-sqlite3 ships N-API prebuilds in its own
# tarball (prebuilds/linux-x64.node) and loads those at runtime. Skipping scripts
# skips the doomed compile and keeps the working prebuild.
#
# Nothing else in the server tree declares an install script (esbuild does, but
# it is a dev dependency, unused by `tsc`, and pruned below). The frontend stage
# above must NOT get this flag — Vite genuinely needs esbuild's binary.
RUN npm ci --ignore-scripts
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# Stage 3: Production image
FROM node:24-slim

# Chromium system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libx11-xcb1 libfontconfig1 libx11-6 \
    libxcb1 libxext6 libxshmfence1 \
    libglib2.0-0 libgtk-3-0 libpangocairo-1.0-0 libcairo-gobject2 \
    libgdk-pixbuf-2.0-0 libxss1 libxtst6 fonts-liberation \
    libgl1-mesa-dri libegl-mesa0 \
    procps wget ca-certificates xclip \
    && rm -rf /var/lib/apt/lists/*

# Camoufox (Firefox) system deps that the Chromium set above does not cover.
# libdbus-glib-1-2 and libxt6 are the ones Firefox will not start without; the
# rest are needed for a real WebGL context, whose absence is itself a bot signal.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libdbus-glib-1-2 libxt6 libxcursor1 libxi6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# Baseline font coverage upstream recommends for Linux hosts: emoji, CJK, and
# Thai. Without these, a page falls back to boxes and the render itself becomes
# a fingerprint. fontconfig is named explicitly (not just libfontconfig1) —
# entrypoint.sh needs fc-cache and server/src/fonts.ts needs fc-list, and both
# currently arrive only transitively via ttf-mscorefonts-installer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
    && rm -rf /var/lib/apt/lists/*

# Windows core fonts (Arial, Times New Roman, Verdana, etc.)
RUN echo "deb http://deb.debian.org/debian trixie contrib" >> /etc/apt/sources.list.d/contrib.list \
    && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
    && apt-get update && apt-get install -y --no-install-recommends ttf-mscorefonts-installer \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Install KasmVNC (auto-selects amd64 or arm64 based on build platform)
ARG TARGETARCH
RUN wget -q https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && apt-get update && apt-get install -y -f ./kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && rm kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Compiled backend + production node_modules
COPY --from=server-builder /build/dist /app/server/dist
COPY --from=server-builder /build/node_modules /app/server/node_modules
COPY --from=server-builder /build/package.json /app/server/package.json

# Frontend build (index.ts resolves ../../frontend/dist relative to server/dist)
COPY --from=frontend-builder /build/dist /app/frontend/dist

# Pre-download the CloakBrowser binary so first launch is instant.
# The free tier needs no license key; CLOAKBROWSER_LICENSE_KEY opts into Pro.
RUN cd /app/server && npx cloakbrowser install

# Pre-download Camoufox for the same reason. This is the big one — the Linux
# archive is ~630 MB compressed — so it is deliberately its own layer, kept
# after the Chromium install so a change to either does not re-pull both.
#
# `fetch` takes no version argument: it resolves the newest release that the
# installed camoufox-js accepts (its CONSTRAINTS range is effectively open), so
# the Camoufox build is pinned by the camoufox-js version in package.json and
# NOT by this line. Two builds of this image on different days can therefore
# ship different Camoufox versions — check GET /api/binary/camoufox to see what
# a running container actually has.
#
# CAMOUFOX_INSTALL_DIR must stay set at runtime too: src/camoufox-binary.ts and
# camoufox-js both resolve the binary through it, and without it the lookup
# falls back to root's ~/.cache.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN cd /app/server && npx camoufox-js fetch

# Smoke-check the Camoufox launch path at build time. launchOptions() samples a
# WebGL fingerprint out of a bundled sqlite database, so it is the one thing that
# would break if better-sqlite3's prebuild ever stopped loading — and it would
# otherwise surface as a failed profile launch in production instead of here.
RUN cd /app/server && node -e "import('camoufox-js').then(m=>m.launchOptions({headless:true,os:'windows'})).then(o=>{if(!o.executablePath||!Object.keys(o.env||{}).some(k=>k.startsWith('CAMOU_CONFIG')))throw new Error('camoufox-js produced no fingerprint config');console.log('camoufox launch options OK')}).catch(e=>{console.error(e);process.exit(1)})"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

VOLUME /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
