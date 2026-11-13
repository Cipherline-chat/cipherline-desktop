# Image for every Linux e2e lab container that runs a desktop session or the API: Ubuntu 24.04 with PipeWire,
# xdg-desktop-portal and four session types (sway/wlroots, KWin, mutter/GNOME, Xvfb+openbox).
# Package set adapted from harness/linux-share-matrix/docker/ubuntu-24.04.Dockerfile (branch claude/linux-share-matrix),
# plus: grim (sway screenshots), imagemagick (X11 `import`), x11-apps/xdotool (X11 input), socat/iproute2 (debug).
# Optional stacks (KDE, GNOME) leave a marker under /opt/cle2e/ so a missing package marks a desktop "not packaged"
# instead of failing the image. node and Electron are mounted from the host (nothing but system libraries lives here).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      ca-certificates dbus dbus-user-session dbus-x11 procps psmisc libsndfile1 python3 coreutils util-linux xz-utils curl iproute2 socat \
      pipewire pipewire-bin pipewire-pulse wireplumber pulseaudio-utils libspa-0.2-modules \
      libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libdrm2 libxkbcommon0 libcups2t64 \
      libatk-bridge2.0-0t64 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libxfixes3 libxcb1 \
      libatspi2.0-0t64 fonts-dejavu-core libglib2.0-bin libwayland-client0 libwayland-egl1 \
      libgl1-mesa-dri libegl1 libegl-mesa0 libglx-mesa0 libgles2 mesa-vulkan-drivers libvulkan1 \
      mesa-va-drivers intel-media-va-driver vainfo libva2 libva-drm2 libva-x11-2 libva-wayland2 \
      sway grim xdg-desktop-portal xdg-desktop-portal-wlr xwayland \
      xvfb openbox x11-utils x11-apps xdotool xauth imagemagick \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/cle2e && touch /opt/cle2e/has-sway /opt/cle2e/has-x11
RUN apt-get update -qq && (apt-get install -y --no-install-recommends kwin-wayland kwin-wayland-backend-virtual xdg-desktop-portal-kde qtwayland5 qt6-wayland \
      && touch /opt/cle2e/has-kde || echo "KDE not installable here") ; rm -rf /var/lib/apt/lists/*
RUN apt-get update -qq && (apt-get install -y --no-install-recommends mutter gnome-shell xdg-desktop-portal-gnome gsettings-desktop-schemas \
      && touch /opt/cle2e/has-gnome || echo "GNOME not installable here") ; rm -rf /var/lib/apt/lists/*
RUN mkdir -m 1777 -p /tmp/.X11-unix; useradd -m -u 1001 -s /bin/bash tester
RUN apt-get update -qq && (apt-get install -y --no-install-recommends kde-spectacle || echo "no spectacle"); rm -rf /var/lib/apt/lists/*
RUN apt-get update -qq && apt-get install -y --no-install-recommends gnome-keyring libsecret-1-0 libsecret-tools && rm -rf /var/lib/apt/lists/*
