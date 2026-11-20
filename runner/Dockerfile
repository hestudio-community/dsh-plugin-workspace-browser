FROM node:22-bookworm-slim

LABEL dev.dsh.dsh-plugin-workspace-browser.runner-protocol="1"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-liberation gosu openbox \
      tigervnc-standalone-server x11-utils xauth xfonts-base \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin browser \
    && useradd --create-home --shell /usr/sbin/nologin dshdesk \
    && install -d -m 0700 -o browser -g browser /profile \
    && install -d -m 1777 /tmp/.X11-unix

WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund --save-exact puppeteer-core@24.31.0
COPY automation.mjs profile-recovery.mjs protocol.mjs proxy.mjs runner.mjs chromium.sh openbox.xml ./
RUN sed -i 's/\r$//' ./chromium.sh && chmod 0755 ./chromium.sh

ARG DSH_PLUGIN_VERSION
LABEL dev.dsh.dsh-plugin-workspace-browser.plugin-version="${DSH_PLUGIN_VERSION}"

ENTRYPOINT ["node", "/app/runner.mjs"]
