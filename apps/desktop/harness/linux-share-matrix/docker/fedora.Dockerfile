# Linux share matrix: Fedora (latest). Intel VA-API encode needs `intel-media-driver`, which Fedora cannot ship
# (patents); it comes from RPM Fusion Free, exactly what a Fedora user with an Intel iGPU installs. Recorded in the report.
FROM fedora:latest
RUN dnf -y install --setopt=install_weak_deps=False --skip-unavailable \
      dbus-daemon dbus-tools procps-ng psmisc coreutils util-linux xz curl python3 libsndfile \
      pipewire pipewire-utils pipewire-pulseaudio wireplumber pulseaudio-utils \
      gtk3 nss alsa-lib libXScrnSaver libXtst cups-libs at-spi2-core at-spi2-atk libgbm libdrm libxkbcommon libX11-xcb \
      libXcomposite libXdamage libXrandr pango cairo libXfixes dejavu-sans-fonts glib2 wayland-devel libwayland-client libwayland-egl \
      mesa-dri-drivers mesa-libEGL mesa-libGL mesa-libgbm mesa-vulkan-drivers vulkan-loader libva libva-utils \
      sway xdg-desktop-portal xdg-desktop-portal-wlr xorg-x11-server-Xwayland \
      xorg-x11-server-Xvfb openbox xorg-x11-utils xdotool xorg-x11-xauth \
 && dnf clean all
RUN (dnf -y install "https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm" \
     && dnf -y install --setopt=install_weak_deps=False --skip-unavailable intel-media-driver libva-intel-media-driver mesa-va-drivers) || echo "rpmfusion intel-media-driver unavailable"; dnf clean all
RUN mkdir -p /opt/clm && command -v sway >/dev/null && touch /opt/clm/has-sway; command -v Xvfb >/dev/null && touch /opt/clm/has-x11; true
RUN dnf -y install --setopt=install_weak_deps=False --skip-unavailable kwin kwin-wayland xdg-desktop-portal-kde qt6-qtwayland || echo "KDE not installable here"; dnf clean all; command -v kwin_wayland >/dev/null && touch /opt/clm/has-kde; true
RUN dnf -y install --setopt=install_weak_deps=False --skip-unavailable mutter gnome-shell xdg-desktop-portal-gnome gsettings-desktop-schemas || echo "GNOME not installable here"; dnf clean all; command -v mutter >/dev/null && touch /opt/clm/has-gnome; true
RUN dnf -y install --setopt=install_weak_deps=False --skip-unavailable python3-dbus; dnf clean all
RUN mkdir -m 1777 -p /tmp/.X11-unix; useradd -m -u 1001 -s /bin/bash tester
