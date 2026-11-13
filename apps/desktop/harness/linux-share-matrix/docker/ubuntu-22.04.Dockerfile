# Linux share matrix: Ubuntu 22.04 (jammy). See ubuntu-24.04.Dockerfile for the layout.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      ca-certificates dbus dbus-user-session dbus-x11 procps psmisc libsndfile1 python3 coreutils util-linux xz-utils curl \
      pipewire pipewire-bin pipewire-pulse wireplumber pulseaudio-utils libspa-0.2-modules \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libdrm2 libxkbcommon0 libcups2 \
      libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libxfixes3 libxcb1 \
      libatspi2.0-0 fonts-dejavu-core libglib2.0-bin libwayland-client0 libwayland-egl1 \
      libgl1-mesa-dri libegl1 libegl-mesa0 libglx-mesa0 libgles2 mesa-vulkan-drivers libvulkan1 \
      mesa-va-drivers intel-media-va-driver vainfo libva2 libva-drm2 libva-x11-2 libva-wayland2 \
      sway xdg-desktop-portal xdg-desktop-portal-wlr xwayland \
      xvfb openbox x11-utils xdotool xauth \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/clm && command -v sway >/dev/null && touch /opt/clm/has-sway; command -v Xvfb >/dev/null && touch /opt/clm/has-x11; true
RUN apt-get update -qq && apt-get install -y --no-install-recommends kwin-wayland xdg-desktop-portal-kde qtwayland5 || echo "KDE not installable here"; rm -rf /var/lib/apt/lists/*; command -v kwin_wayland >/dev/null && touch /opt/clm/has-kde; true
RUN apt-get update -qq && apt-get install -y --no-install-recommends mutter gnome-shell xdg-desktop-portal-gnome gsettings-desktop-schemas || echo "GNOME not installable here"; rm -rf /var/lib/apt/lists/*; command -v mutter >/dev/null && touch /opt/clm/has-gnome; true
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3-dbus || true; rm -rf /var/lib/apt/lists/*
RUN mkdir -m 1777 -p /tmp/.X11-unix; useradd -m -u 1001 -s /bin/bash tester
