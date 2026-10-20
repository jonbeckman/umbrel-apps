# GitHub's official runner, plus the fleet toolchain.
# Base images are official and digest-pinned. Renovate may open a PR to
# bump them; nothing here auto-merges.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS node

FROM ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807

USER root
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod 0644 /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends zstd build-essential gh docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && gh --version \
 && docker compose version \
 && zstd --version

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version | grep -qx 'v24.15.0'

# Checksum from the v0.9.6 release sidecar nub-linux-x64.tar.gz.sha256,
# committed here so a swapped artifact fails the build.
ARG NUB_VERSION=0.9.6
ARG NUB_SHA256=77220dc6deb6ebbdb0a282c61b80a157e32016e088f3632d8fb4bf74a931e4ce
RUN curl -fsSL -o /tmp/nub.tgz "https://github.com/nubjs/nub/releases/download/v${NUB_VERSION}/nub-linux-x64.tar.gz" \
 && echo "${NUB_SHA256}  /tmp/nub.tgz" | sha256sum -c - \
 && mkdir -p /opt/nub \
 && tar -xzf /tmp/nub.tgz -C /opt/nub \
 && ln -sf /opt/nub/bin/nub /usr/local/bin/nub \
 && ln -sf /opt/nub/bin/nubx /usr/local/bin/nubx \
 && ln -sf /opt/nub/bin/nubr /usr/local/bin/nubr \
 && rm /tmp/nub.tgz \
 && nub --version | grep -qx "v${NUB_VERSION}"

COPY entrypoint.sh /usr/local/bin/jonbeckman-runner-entrypoint
RUN chmod 0755 /usr/local/bin/jonbeckman-runner-entrypoint
USER runner
# CMD stays unset. A base-image CMD would be appended to this entrypoint
# and handed to run.sh as an extra argument.
ENTRYPOINT ["/usr/local/bin/jonbeckman-runner-entrypoint"]
