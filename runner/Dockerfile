FROM node:22-bookworm-slim

ARG DSH_RUNNER_PROTOCOL
LABEL dev.dsh.dsh-plugin-workspace-browser.runner-protocol="${DSH_RUNNER_PROTOCOL}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-liberation fonts-noto-core fonts-noto-cjk \
      fonts-noto-color-emoji util-linux openbox \
      tigervnc-standalone-server x11-utils xauth xclip xdotool xfonts-base \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin browser \
    && useradd --create-home --shell /usr/sbin/nologin dshdesk \
    && install -d -m 0700 -o browser -g browser /profile \
    && install -d -m 1777 /tmp/.X11-unix \
    && install -d /etc/chromium/policies/recommended \
    && printf '%s\n' '{"DownloadDirectory":"/workspace"}' > /etc/chromium/policies/recommended/workspace.json

WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund --save-exact puppeteer-core@24.31.0
COPY automation.mjs clipboard.mjs identity.mjs profile-recovery.mjs protocol.mjs proxy.mjs runner.mjs window-title.mjs chromium.sh openbox.xml ./
RUN sed -i 's/\r$//' ./chromium.sh && chmod 0755 ./chromium.sh

ARG DSH_PLUGIN_VERSION
LABEL dev.dsh.dsh-plugin-workspace-browser.plugin-version="${DSH_PLUGIN_VERSION}"

ENTRYPOINT ["node", "/app/runner.mjs"]
