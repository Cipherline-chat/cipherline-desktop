# Throwaway PipeWire desktop-audio stack for proving src-native/audio_capture_linux.cc.
# Just the daemon, the session manager, the pulse bridge and the CLI players (no sound card: the test
# creates a null sink; node is mounted from the host), plus a bare X server and xterm for the
# window -> pid (_NET_WM_PID) check in x11-pid.sh.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      pipewire pipewire-bin pipewire-pulse wireplumber pulseaudio-utils \
      dbus dbus-user-session libsndfile1 ca-certificates \
      xvfb xterm x11-utils libx11-6 \
 && rm -rf /var/lib/apt/lists/*
