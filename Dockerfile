FROM mcr.microsoft.com/playwright:v1.61.0-noble
# That base image ships a Playwright-tested Chromium build plus all of its OS-level
# dependencies already installed - the single biggest source of flakiness in DIY
# Playwright Docker setups. We only need to layer on Xvfb/PulseAudio/ffmpeg ourselves.

RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        pulseaudio \
        pulseaudio-utils \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm install --include=dev && npm run build && npm prune --omit=dev

ENV DISPLAY=:99
ENV PULSE_RUNTIME_PATH=/tmp/pulse
ENV XDG_RUNTIME_DIR=/tmp/pulse
ENV X11_WIDTH=1280
ENV X11_HEIGHT=720
ENV RECORDINGS_DIR=/app/Recordings
ENV PORT=3000

COPY start.sh /start.sh
# Strip Windows CRLF so the shebang works on Linux (common after git clone on Windows).
RUN sed -i 's/\r$//' /start.sh && chmod +x /start.sh

EXPOSE 3000
ENTRYPOINT ["/start.sh"]
