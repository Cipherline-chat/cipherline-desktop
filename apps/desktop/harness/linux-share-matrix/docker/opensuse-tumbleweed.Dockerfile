# Linux share matrix: openSUSE Tumbleweed. zypper installs what it can find and reports the rest, so the lists are
# loose; markers are set from the binaries that really landed.
FROM opensuse/tumbleweed:latest
RUN zypper -n --gpg-auto-import-keys ref >/dev/null 2>&1; \
    zypper -n in --no-recommends \
      dbus-1 dbus-1-daemon dbus-1-tools procps psmisc coreutils util-linux xz curl python3 libsndfile1 shadow \
      pipewire pipewire-tools pipewire-pulseaudio pipewire-spa-plugins-0_2 wireplumber wireplumber-audio pulseaudio-utils \
      libgtk-3-0 mozilla-nss alsa-lib libXss1 libXtst6 libcups2 at-spi2-core libatk-bridge-2_0-0 libgbm1 libdrm2 libxkbcommon0 libX11-xcb1 \
      libXcomposite1 libXdamage1 libXrandr2 pango-tools libpango-1_0-0 libcairo2 libXfixes3 dejavu-fonts glib2-tools libwayland-client0 libwayland-egl1 \
      Mesa-dri Mesa-libEGL1 Mesa-libGL1 Mesa-libva Mesa-vulkan-device-select libvulkan1 libva-utils libva2 intel-media-driver \
      sway xdg-desktop-portal xdg-desktop-portal-wlr xwayland \
      xorg-x11-server-Xvfb openbox xdpyinfo xdotool xauth \
 ; zypper clean -a
RUN mkdir -p /opt/clm && command -v sway >/dev/null && touch /opt/clm/has-sway; command -v Xvfb >/dev/null && touch /opt/clm/has-x11; true
RUN zypper -n in --no-recommends kwin6 xdg-desktop-portal-kde qt6-wayland || echo "KDE not installable here"; zypper clean -a; command -v kwin_wayland >/dev/null && touch /opt/clm/has-kde; true
RUN zypper -n in --no-recommends mutter gnome-shell xdg-desktop-portal-gnome gsettings-desktop-schemas || echo "GNOME not installable here"; zypper clean -a; command -v mutter >/dev/null && touch /opt/clm/has-gnome; true
RUN zypper -n in --no-recommends python3-dbus-python; zypper clean -a
RUN mkdir -m 1777 -p /tmp/.X11-unix; useradd -m -u 1001 -s /bin/bash tester
