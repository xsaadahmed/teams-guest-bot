#!/bin/bash
set -e

echo "Starting virtual display..."
Xvfb :99 -screen 0 "${X11_WIDTH}x${X11_HEIGHT}x24" -ac +extension GLX +render -noreset -nolisten tcp &
sleep 1

if [ "${ENABLE_VNC:-true}" = "true" ]; then
  echo "Starting VNC server on :5900 (password: ${VNC_PASSWORD:-debug}) for watching the bot join..."
  x11vnc -display :99 -forever -shared -passwd "${VNC_PASSWORD:-debug}" -listen 0.0.0.0 -rfbport 5900 -bg -o /tmp/x11vnc.log || true
fi

echo "Starting PulseAudio..."
mkdir -p "$PULSE_RUNTIME_PATH"
# --exit-idle-time=-1 is critical: without it the daemon shuts down after ~20s with no
# clients connected, and a later autospawn comes back WITHOUT our null sink, so by the time
# recording starts (after the browser launch + lobby wait) virtual_speaker.monitor is gone
# and ffmpeg fails with "No such process".
pulseaudio --start --exit-idle-time=-1 --log-target=stderr --log-level=warn
sleep 2

if ! pactl info >/dev/null 2>&1; then
  echo "PulseAudio did not come up cleanly, retrying once..."
  pulseaudio --kill || true
  sleep 1
  pulseaudio --start --exit-idle-time=-1 --log-target=stderr --log-level=warn
  sleep 2
fi

echo "Creating virtual speaker sink..."
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=Virtual_Speaker
pactl set-default-sink virtual_speaker
pactl set-sink-volume virtual_speaker 100%

# Keep the monitor source from being suspended when momentarily idle - a suspended source
# can also trip up ffmpeg's pulse capture.
pactl unload-module module-suspend-on-idle 2>/dev/null || true

if ! pactl list sources short | grep -q "virtual_speaker.monitor"; then
  echo "virtual_speaker.monitor not found - audio setup failed" >&2
  exit 1
fi

echo "Audio/display ready. Starting bot server..."
mkdir -p "$RECORDINGS_DIR"
exec node build/server.js
