# Arch-based sharer image (the closest container to the owner's CachyOS tester) with the FREE iHD driver (intel-media-driver:
# VAEntrypointEncSlice, not just EncSliceLP), for the hardware-encode run.  LAB_IMAGE=cle2e-arch run.sh desktop=sway vaapi
# Package set adapted from harness/linux-share-matrix/docker/arch.Dockerfile (branch claude/linux-share-matrix) plus the lab's tools.
# pacman aborts a whole transaction on one unknown name, so packages go in one at a time and a miss is only logged.
FROM archlinux:latest
RUN printf '#!/bin/sh\nfor p in "$@"; do if out=$(pacman -Sy --noconfirm --needed "$p" 2>&1); then echo "pac ok   $p"; else echo "pac MISS $p :: $(echo "$out" | tail -2 | tr "\\n" " ")"; fi; done\n' > /usr/local/bin/pac && chmod +x /usr/local/bin/pac
RUN pacman -Syu --noconfirm >/dev/null 2>&1; \
    pac dbus procps-ng psmisc coreutils util-linux xz curl python libsndfile iproute2 socat \
      pipewire pipewire-pulse pipewire-audio wireplumber libpulse gsettings-desktop-schemas dconf glib2 \
      gtk3 nss alsa-lib libxss libxtst libcups at-spi2-core libdrm mesa libxkbcommon libxcomposite libxdamage libxrandr pango cairo libxfixes ttf-dejavu wayland \
      vulkan-icd-loader libva libva-utils libva-mesa-driver intel-media-driver vulkan-intel \
      sway grim xdg-desktop-portal xdg-desktop-portal-wlr xorg-xwayland \
      xorg-server-xvfb openbox xorg-xdpyinfo xorg-xauth xdotool xorg-xwd imagemagick \
      gnome-keyring libsecret; \
    rm -rf /var/cache/pacman/pkg/*
RUN mkdir -p /opt/cle2e && command -v sway >/dev/null && touch /opt/cle2e/has-sway; command -v Xvfb >/dev/null && touch /opt/cle2e/has-x11; true
RUN glib-compile-schemas /usr/share/glib-2.0/schemas || true
RUN mkdir -m 1777 -p /tmp/.X11-unix; useradd -m -u 1001 -s /bin/bash tester
