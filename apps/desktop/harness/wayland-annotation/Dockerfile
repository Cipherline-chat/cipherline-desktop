# Throwaway headless-compositor lab for proving the Wayland annotation overlay
# (src-native/wayland_overlay/). Three real compositors, no GPU, no host packages:
#   sway   (wlroots) - WLR_BACKENDS=headless      screenshots: grim
#   kwin   (KDE)     - kwin_wayland --virtual     screenshots: / KWin ScreenShot2
#   mutter (GNOME)   - mutter --headless --virtual-monitor   (no layer-shell: XWayland experiment)
# plus a C toolchain, wayland-scanner (only to cross-check the hand-written protocol tables), and
# the X11 libs for the XWayland override-redirect experiment.
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config ca-certificates \
      libwayland-dev wayland-protocols wayland-utils libwayland-bin \
      sway grim wlrctl \
      kwin-wayland plasma-wayland-protocols qt6-wayland \
      mutter gnome-shell xwayland \
      libx11-dev libxext-dev libxrandr-dev libxfixes-dev libxcomposite-dev x11-utils x11-xserver-utils xdotool \
      dbus dbus-x11 dbus-user-session procps \
      python3 python3-gi gir1.2-gtk-3.0 python3-pil imagemagick \
      pipewire gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-tools \
 && rm -rf /var/lib/apt/lists/*

# GTK draws through cairo; the python bridge is a separate package.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3-gi-cairo python3-cairo \
 && rm -rf /var/lib/apt/lists/*

# Compositors without a screenshot tool of their own (KWin virtual = QPainter only, Mutter) are captured the
# way a real screen share is: the compositor streams into PipeWire, gstreamer reads one frame.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends wireplumber pipewire-bin gstreamer1.0-plugins-base-apps \
 && rm -rf /var/lib/apt/lists/*

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends xvfb x11-apps \
 && rm -rf /var/lib/apt/lists/*

# Plain-X11 proof (lab/run-x11.sh): a real compositing manager that can be started and killed mid-run
# (picom, xcompmgr), a window manager that publishes EWMH state (openbox), and xdotool to move windows.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends picom xcompmgr openbox xdotool \
 && rm -rf /var/lib/apt/lists/*
