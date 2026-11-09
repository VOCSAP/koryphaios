ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION} AS bun

# The ubuntu runner ships the Chrome dependencies Electron needs and xvfb-run (with xauth)
# for the Electron tests; node 24 matches the workflow's setup-node.
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libgtk-3-0 libgbm1 libasound2 libxss1 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libpango-1.0-0 \
    libcairo2 libdrm2 libx11-xcb1 xvfb xauth ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# bun lives under the home of the runner user, as on the runner: a test that fakes a bun
# path must not collide with process.execPath, which /usr/local/bin/bun would cause.
RUN useradd -m -u 1001 -s /bin/bash runner \
 && mkdir -p /home/runner/.bun/bin /work /out \
 && chown -R runner:runner /home/runner /work /out \
 && chmod 1777 /work /out
COPY --from=bun /usr/local/bin/bun /home/runner/.bun/bin/bun
RUN git config --system --add safe.directory '*' \
 && git config --system user.email ci-replay@example.invalid \
 && git config --system user.name ci-replay
USER runner
ENV PATH=/home/runner/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/tmp/home \
    CI=true
WORKDIR /work
