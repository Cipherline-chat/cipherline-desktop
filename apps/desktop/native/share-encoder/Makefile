# Native share encoder helper. Build deps: gcc + libva-dev (headers only; runtime is libva.so.2).
#   make                       -> build/share-encoder-helper
#   make VA_INC=/path/include  -> libva headers from an extracted libva-dev .deb (no root needed)
#   make NV_INC=<dir containing ffnvcodec/nvEncodeAPI.h>   (apt: libffmpeg-nvenc-dev) turns the NVENC backend on
#   make PW_INC=<dir containing pipewire-0.3/ and spa-0.2/> (apt: libpipewire-0.3-dev libspa-0.2-dev) for the capture path
# libpipewire, libcuda, libnvidia-encode, libva and libva-drm are all dlopen'd at run time (no DT_NEEDED on any of them): the binary starts without them and
# reports "unavailable" instead of failing to load.
VA_INC ?= /usr/include
PW_INC ?= /usr/include
NV_INC ?=
TEST_FLAGS = $(if $(TEST_HOOKS),-DCL_TEST_HOOKS,)
NV_FLAGS = $(if $(NV_INC),-DCL_HAVE_NVENC_HEADERS -I$(NV_INC),)
CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers
SRCS = share-encoder-helper.c share-capture.c capture.c portal.c dbus_mini.c enc_vaapi.c enc_nvenc.c enc_pcm.c
HDRS = pacer.h encoder.h capture.h portal.h dbus_mini.h share-capture.h lowlayer.h preview.h
build/share-encoder-helper: $(SRCS) $(HDRS)
	@mkdir -p build
	$(CC) $(CFLAGS) $(NV_FLAGS) $(TEST_FLAGS) -I$(VA_INC) -I$(PW_INC)/pipewire-0.3 -I$(PW_INC)/spa-0.2 -o $@ $(SRCS) -ldl
build/dbus_mini_test: dbus_mini_test.c dbus_mini.c dbus_mini.h
	@mkdir -p build
	$(CC) $(CFLAGS) -fsanitize=address,undefined -o $@ dbus_mini_test.c dbus_mini.c
build/pacer_test: pacer_test.c pacer.h
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ pacer_test.c
build/lowlayer_test: lowlayer_test.c lowlayer.h enc_pcm.c encoder.h pacer.h
	@mkdir -p build
	$(CC) $(CFLAGS) -fsanitize=address,undefined -o $@ lowlayer_test.c enc_pcm.c
build/preview_test: preview_test.c preview.h lowlayer.h
	@mkdir -p build
	$(CC) $(CFLAGS) -fsanitize=address,undefined -o $@ preview_test.c enc_pcm.c
test: build/dbus_mini_test build/pacer_test build/lowlayer_test build/preview_test
	build/dbus_mini_test
	build/pacer_test
	build/lowlayer_test
	build/preview_test
clean:
	rm -rf build

# VA-API control-logic tests against a mock libva (no GPU needed): TEST_HOOKS build of the helper + test/mock_libva.c, see test/test-vaapi.sh
build/libva-mock.so: test/mock_libva.c
	@mkdir -p build
	$(CC) $(CFLAGS) -shared -fPIC -I$(VA_INC) -o $@ test/mock_libva.c
test-vaapi: build/libva-mock.so
	@mkdir -p build
	$(CC) $(CFLAGS) $(NV_FLAGS) -DCL_TEST_HOOKS -I$(VA_INC) -I$(PW_INC)/pipewire-0.3 -I$(PW_INC)/spa-0.2 -o build/share-encoder-helper-test $(SRCS) -ldl
	bash test/test-vaapi.sh

# Self-contained build from the MIT headers vendored in third_party/ (libva, nv-codec-headers) and ../../src-native/third_party/pipewire
# (PipeWire/SPA): no -dev packages needed. This is what the glibc-2.31 release container runs (scripts/rebuild-native-linux-compat.sh).
vendored:
	@mkdir -p build
	$(CC) $(CFLAGS) -DCL_HAVE_NVENC_HEADERS $(TEST_FLAGS) -Ithird_party/include -o build/share-encoder-helper $(SRCS) -ldl
