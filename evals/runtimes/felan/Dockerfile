# syntax=docker/dockerfile:1
FROM node:22.20.0-trixie-slim@sha256:f3bca16c4b87ad0c7abfad97f6803898ee9b08a1f153a269140f0a08f50231d2

ARG PNPM_VERSION=9.15.5
ARG RTK_VERSION=0.45.0
ARG RTK_INSTALLER_COMMIT=b34be37caf3796b69a50952a28e60e32b5daad43
ARG RTK_INSTALLER_SHA256=d6eb73a772903e13ff34ee1be8a8b24e896ba9a978f20d2279a08b4083ea6f77
ARG PYTHON_VERSION=3.13.5-1
ARG PYTHON_RUNTIME_VERSION=3.13.5-2+deb13u5
ARG MARKITDOWN_VERSION=0.1.7
ARG MARKITDOWN_REQUIREMENTS_SHA256=78c8fcecc43017bb511850fe4071bd413099666c344664905d1fe56216ac97bd
ARG CA_CERTIFICATES_VERSION=20250419
ARG CURL_VERSION=8.14.1-2+deb13u5
ARG GIT_VERSION=1:2.47.3-0+deb13u1
ARG RIPGREP_VERSION=14.1.1-1+b4

# codebase-memory-mcp is hard-pinned by @felan-ai/ext-codebase-memory (strict
# version equality). Bump CBM_VERSION and CBM_INSTALLER_{COMMIT,SHA256} together
# from packages/ext-codebase-memory/src/{client,installer}.ts when re-benchmarking
# a newer release, then rebuild this image.
ARG CBM_VERSION=0.10.8
ARG CBM_INSTALLER_COMMIT=46ae198fc11cda80e817acbc5f5908d7c2de7032
ARG CBM_INSTALLER_SHA256=2fdd4d6563fc8e540bb32e233c5fdef22ecf05d7ebd5a80657cd4fec953b3475

LABEL org.felan.evals.runtime="felan-v1"
LABEL org.felan.evals.rtk-version="${RTK_VERSION}"
LABEL org.felan.evals.markitdown-version="${MARKITDOWN_VERSION}"
LABEL org.felan.evals.markitdown-requirements-sha256="${MARKITDOWN_REQUIREMENTS_SHA256}"
LABEL org.felan.evals.cbm-version="${CBM_VERSION}"
LABEL org.felan.evals.ripgrep-version="${RIPGREP_VERSION}"

ENV RTK_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    "ca-certificates=${CA_CERTIFICATES_VERSION}" \
    "curl=${CURL_VERSION}" \
    "git=${GIT_VERSION}" \
    "python3=${PYTHON_VERSION}" \
    "python3-venv=${PYTHON_VERSION}" \
    "python3.13=${PYTHON_RUNTIME_VERSION}" \
    "python3.13-venv=${PYTHON_RUNTIME_VERSION}" \
    "ripgrep=${RIPGREP_VERSION}" \
  && test "$(rg --version | head -n1)" = "ripgrep 14.1.1" \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "pnpm@${PNPM_VERSION}" \
  && npm cache clean --force

COPY evals/runtimes/felan/markitdown-requirements.txt /tmp/markitdown-requirements.txt
RUN test "$(tr -d '\r' < /tmp/markitdown-requirements.txt | sha256sum | cut -d ' ' -f 1)" = "${MARKITDOWN_REQUIREMENTS_SHA256}" \
  && python3 -m venv /opt/markitdown \
  && /opt/markitdown/bin/pip install --no-cache-dir --require-hashes -r /tmp/markitdown-requirements.txt \
  && test "$(/opt/markitdown/bin/markitdown --version)" = "markitdown ${MARKITDOWN_VERSION}"

RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --max-filesize 65536 \
    "https://raw.githubusercontent.com/rtk-ai/rtk/${RTK_INSTALLER_COMMIT}/install.sh" \
    --output /tmp/install-rtk.sh \
  && printf '%s  %s\n' "${RTK_INSTALLER_SHA256}" /tmp/install-rtk.sh \
    | sha256sum --check --strict - \
  && RTK_VERSION="v${RTK_VERSION}" RTK_INSTALL_DIR=/usr/local/bin \
    /bin/sh /tmp/install-rtk.sh \
  && test "$(rtk --version)" = "rtk ${RTK_VERSION}" \
  && rm /tmp/install-rtk.sh

# Bake the pinned codebase-memory-mcp binary onto PATH so the felan-cbm-on
# profile does not pay the installer cost at session start. The binary is inert
# for every other case (they do not enable builtinExtensions.codebaseMemory).
# This mirrors the extension's own install path: fetch the commit-pinned
# install.sh, verify its digest, then let it download + checksum-verify the
# release archive for the build architecture.
RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --max-filesize 131072 \
    "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/${CBM_INSTALLER_COMMIT}/install.sh" \
    --output /tmp/install-cbm.sh \
  && printf '%s  %s\n' "${CBM_INSTALLER_SHA256}" /tmp/install-cbm.sh \
    | sha256sum --check --strict - \
  && CBM_DOWNLOAD_URL="https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}" \
    /bin/bash /tmp/install-cbm.sh --dir /usr/local/bin --skip-config \
  && test "$(codebase-memory-mcp --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)" = "${CBM_VERSION}" \
  && rm -f /tmp/install-cbm.sh /usr/local/bin/install.sh

ENV PATH="/opt/markitdown/bin:${PATH}" \
    SHELL=/bin/bash

WORKDIR /workspace
