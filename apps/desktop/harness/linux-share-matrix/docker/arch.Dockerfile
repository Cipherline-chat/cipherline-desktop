# Linux share matrix: Arch Linux (rolling) — the closest container to the owner's CachyOS tester (same package versions
# modulo CachyOS's rebuilt x86-64-v3 binaries; cachyos.Dockerfile tries the real thing).
# pacman aborts the whole transaction on one unknown name, so packages go in one at a time and a miss is just logged.
FROM archlinux:latest
RUN cat > /usr/local/bin/pac <<'EOS'
#!/bin/sh
for p in "$@"; do if out=$(pacman -Sy --noconfirm --needed "$p" 2>&1); then echo "pac ok   $p"; else echo "pac MISS $p :: $(echo "$out" | tail -2 | tr "\n" " ")"; fi; done
EOS
RUN chmod +x /usr/local/bin/pac && pacman -Syu --noconfirm >/dev/null 2>&1; \
    pac dbus procps-ng psmisc coreutils util-linux xz curl python libsndfile \
      pipewire pipewire-pulse pipewire-audio wireplumber libpulse gsettings-desktop-schemas dconf glib2 \
      gtk3 nss alsa-lib libxss libxtst libcups at-spi2-core libdrm mesa libxkbcommon libxcomposite libxdamage libxrandr pango cairo libxfixes ttf-dejavu glib2 wayland \
      vulkan-icd-loader vulkan-mesa-layers libva libva-utils libva-mesa-driver mesa-va-drivers intel-media-driver vulkan-intel \
      sway xdg-desktop-portal xdg-desktop-portal-wlr xorg-xwayland \
      xorg-server-xvfb openbox xorg-xdpyinfo xorg-xauth xdotool; \
    rm -rf /var/cache/pacman/pkg/*
RUN mkdir -p /opt/clm && command -v sway >/dev/null && touch /opt/clm/has-sway; command -v Xvfb >/dev/null && touch /opt/clm/has-x11; true
RUN pac kwin xdg-desktop-portal-kde qt6-wayland; rm -rf /var/cache/pacman/pkg/*; command -v kwin_wayland >/dev/null && touch /opt/clm/has-kde; true
RUN pac mutter gnome-shell xdg-desktop-portal-gnome gsettings-desktop-schemas; rm -rf /var/cache/pacman/pkg/*; command -v mutter >/dev/null && touch /opt/clm/has-gnome; true
RUN pac python-dbus
# pacman hooks do not always run in a container: without compiled schemas glib aborts ("No GSettings schemas are installed")
RUN glib-compile-schemas /usr/share/glib-2.0/schemas || true
RUN mkdir -m 1777 -p /tmp/.X11-unix; useradd -m -u 1001 -s /bin/bash tester
