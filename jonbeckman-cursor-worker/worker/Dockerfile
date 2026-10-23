# Ubuntu 24.04 worker image, adapted from the Cursor cookbook Dockerfile
# (cursor/cookbook self-hosted-cloud-agent). That entrypoint starts a pool
# worker with a service-account key. This image only installs the toolchain.
# The setup server clones repositories and starts My Machines mode.
#
# Base images are official and digest-pinned. The Cursor CLI itself comes
# from https://cursor.com/install, which tracks the current CLI build.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS node

FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git build-essential \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && git --version \
 && gh --version \
 && gcc --version

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version | grep -qx 'v24.15.0'

RUN groupadd --gid 1001 cursor \
 && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash cursor \
 && mkdir -p /workspaces /state /home/cursor/.cursor /home/cursor/.config/cursor \
 && chown -R cursor:cursor /workspaces /state /home/cursor

COPY server.mjs lib.mjs credential.mjs index.html page.js /app/
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/credential.mjs "$@"' > /usr/local/bin/git-credential-cursor \
 && chmod 755 /usr/local/bin/git-credential-cursor \
 && chmod 644 /app/server.mjs /app/lib.mjs /app/credential.mjs /app/index.html /app/page.js

USER cursor
ENV HOME=/home/cursor \
    PATH="/home/cursor/.local/bin:/usr/local/bin:${PATH}"
# pipefail so a failed download does not look like a successful install.
RUN bash -o pipefail -c 'curl https://cursor.com/install -fsS | bash' \
 && agent --version

WORKDIR /home/cursor
EXPOSE 3502
CMD ["node", "/app/server.mjs"]
