FROM node:24-bookworm-slim

ENV APP_HOME=/app \
    NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR ${APP_HOME}

COPY package.json package-lock.json README.md LICENSE ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/hkclaw-lite-entrypoint

RUN chmod +x /usr/local/bin/hkclaw-lite-entrypoint \
  && useradd --create-home --shell /bin/bash --uid 10001 hkclaw \
  && mkdir -p /data /workspace \
  && chown -R 10001:10001 /app /data /workspace

USER 10001:10001
WORKDIR /data

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hkclaw-lite-entrypoint"]
CMD []
