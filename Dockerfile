# Build Cuttlely and the vendored Hermes runtime.
# docker build -t cuttlely .
#
# Hermes uv.lock installs on CPython 3.14 with glibc wheels. Alpine/musl is not
# that lockfile's environment. Bookworm is glibc 2.36, and the sqlite3 napi
# prebuild needs GLIBC_2.38 and GLIBCXX_3.4.31, so this image is Debian trixie.
# Node stays 24. The harness queue uses node:sqlite.
#
# Render sets PORT. The server listens on HOST:PORT. The start script defaults
# PORT to 43117 only when the platform did not set it.
# scripts/start-cuttlely.sh starts Hermes on 127.0.0.1 and then Cuttlely.

FROM node:24-trixie-slim

# uv is pinned to the release hermes/pm/lock.json pins and checked against the same sha256. To update it, change
# UV_VERSION and both checksums (linux-x64 and linux-arm64 in hermes/pm/lock.json).
ARG TARGETARCH
ARG UV_VERSION=0.12.3

RUN echo "Cuttlely image, step 1 of 4: system packages (a few minutes on the first build)" \
    && apt-get update && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        python3 \
        make \
        g++ \
        build-essential \
        pkg-config \
        git \
        libcairo2-dev \
        libpango1.0-dev \
        libjpeg62-turbo-dev \
        libgif-dev \
        librsvg2-dev \
        chromium \
        util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.33.4 \
    && case "${TARGETARCH:-amd64}" in \
        amd64) UV_ARCH=x86_64; UV_SHA256=600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101 ;; \
        arm64) UV_ARCH=aarch64; UV_SHA256=bb66cb52e7b1823aed1183630d8d8e5c958840d584a4c55ec10a4cfc168dcca2 ;; \
        *) echo "No pinned uv for ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_ARCH}-unknown-linux-gnu.tar.gz" \
    && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
    && rm /tmp/uv.tar.gz \
    && uv --version \
    && CHROME="$(command -v chromium || command -v chromium-browser)" \
    && test -n "$CHROME" \
    && ln -sfn "$CHROME" /usr/local/bin/cuttlely-chromium

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/cuttlely-chromium
# The image build needs a large heap. The runtime value is set again after the build.
ENV NODE_OPTIONS=--max-old-space-size=8192
# uv's CPython lives outside the venv. The node user has to be able to execute it.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python

WORKDIR /usr/src/cuttlely

COPY . .

RUN mkdir -p /opt/uv-python \
    && chmod 755 scripts/render-entrypoint.sh scripts/start-cuttlely.sh scripts/setup-hermes.sh \
    && echo "Cuttlely image, step 2 of 4: installing packages (several minutes on the first build)" \
    && pnpm install \
    && echo "Cuttlely image, step 3 of 4: building Cuttlely (several minutes)" \
    && pnpm build:docker \
    && echo "Cuttlely image, step 4 of 4: setting up the agent runtime" \
    && bash scripts/setup-hermes.sh \
    && chmod -R a+rX /opt/uv-python \
    && chown -R node:node /usr/src/cuttlely

LABEL org.opencontainers.image.title="cuttlely" \
      org.opencontainers.image.description="Build, run and improve AI applications on infrastructure you control." \
      org.opencontainers.image.source="https://github.com/cuttlely/cuttlely" \
      org.opencontainers.image.licenses="Apache-2.0"

# Do not keep the build heap. An 8 GB reservation will not start on the Render plan.
ENV NODE_OPTIONS=--max-old-space-size=2048
ENV HOST=0.0.0.0

EXPOSE 43117

# docker run and Compose report healthy once ping answers. The first start can take a few minutes.
HEALTHCHECK --interval=15s --timeout=5s --start-period=300s --retries=20 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-43117}/api/v1/ping" || exit 1

# Root at start so the persistent disk can be chowned, then the entrypoint drops to node.
ENTRYPOINT ["bash", "scripts/render-entrypoint.sh"]
CMD ["bash", "scripts/start-cuttlely.sh"]
