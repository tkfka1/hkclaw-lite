FROM node:24-bookworm-slim

ARG TARGETOS=linux
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.35.0
ARG ARGOCD_VERSION=v3.2.1
ARG HKCLAW_LITE_CODEX_CLI_VERSION
ARG HKCLAW_LITE_CLAUDE_AGENT_SDK_VERSION
ARG HKCLAW_LITE_GEMINI_CLI_VERSION

ENV APP_HOME=/app \
    NODE_ENV=production \
    HOME=/home/hkclaw \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client ripgrep tini; \
  arch="${TARGETARCH:-}"; \
  if [ -z "${arch}" ]; then \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "Unsupported dpkg architecture: $(dpkg --print-architecture)"; exit 1 ;; \
    esac; \
  fi; \
  case "${arch}" in amd64|arm64) ;; *) echo "Unsupported TARGETARCH: ${arch}"; exit 1 ;; esac; \
  curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${TARGETOS}/${arch}/kubectl"; \
  chmod +x /usr/local/bin/kubectl; \
  curl -fsSL -o /usr/local/bin/argocd "https://github.com/argoproj/argo-cd/releases/download/${ARGOCD_VERSION}/argocd-${TARGETOS}-${arch}"; \
  chmod +x /usr/local/bin/argocd; \
  rm -rf /var/lib/apt/lists/*

WORKDIR ${APP_HOME}

COPY package.json package-lock.json README.md LICENSE ./
RUN set -eux; \
  npm ci --omit=dev; \
  if [ -n "${HKCLAW_LITE_CODEX_CLI_VERSION:-}" ]; then \
    npm install --omit=dev --package-lock=false --save=false "@openai/codex@${HKCLAW_LITE_CODEX_CLI_VERSION}"; \
  fi; \
  if [ -n "${HKCLAW_LITE_CLAUDE_AGENT_SDK_VERSION:-}" ]; then \
    npm install --omit=dev --package-lock=false --save=false "@anthropic-ai/claude-agent-sdk@${HKCLAW_LITE_CLAUDE_AGENT_SDK_VERSION}"; \
  fi; \
  if [ -n "${HKCLAW_LITE_GEMINI_CLI_VERSION:-}" ]; then \
    npm install --omit=dev --package-lock=false --save=false "@google/gemini-cli@${HKCLAW_LITE_GEMINI_CLI_VERSION}"; \
  fi; \
  npm ls --omit=dev @openai/codex @anthropic-ai/claude-agent-sdk @google/gemini-cli --depth=0; \
  npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/hkclaw-lite-entrypoint

RUN chmod +x /usr/local/bin/hkclaw-lite-entrypoint \
  && useradd --create-home --shell /bin/bash --uid 10001 hkclaw \
  && mkdir -p /workspace \
  && chown 10001:10001 /home/hkclaw /workspace

USER 10001:10001
WORKDIR /home/hkclaw

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hkclaw-lite-entrypoint"]
CMD []
