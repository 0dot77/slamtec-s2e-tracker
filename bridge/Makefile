# Builds the S2E sensor bridge against the prebuilt Slamtec SDK static lib.
# `npm run bridge:setup` fetches the SDK and builds this target.

SDK     := third_party/rplidar_sdk
SDK_INC := -I$(SDK)/sdk/include -I$(SDK)/sdk/src
UNAME_S := $(shell uname -s)
SDK_PLATFORM := $(if $(filter Darwin,$(UNAME_S)),Darwin,Linux)
SDK_LIB := $(SDK)/output/$(SDK_PLATFORM)/Release/libsl_lidar_sdk.a
SDK_SHA := $(shell test -e $(SDK)/.git && git -C $(SDK) rev-parse HEAD 2>/dev/null)
SDK_STAMP := $(SDK)/.s2e-bridge-sdk-sha

CXX      := clang++
CXXFLAGS := -std=c++11 -O2 -Wall -pthread $(SDK_INC)
LDFLAGS  := -pthread

BIN_DIR := bin
BIN := $(BIN_DIR)/s2e_bridge

all: $(BIN)

$(BIN): src/main.cpp $(SDK_LIB) | $(BIN_DIR)
	$(CXX) $(CXXFLAGS) -o $(BIN) src/main.cpp $(SDK_LIB) $(LDFLAGS)

$(SDK_LIB): $(SDK_STAMP)
	$(MAKE) -C $(SDK)

# Compare contents every invocation, but keep the timestamp when unchanged.
# Checkout can leave an archive/objects built from an older SDK revision.
$(SDK_STAMP): FORCE
	@test -n "$(SDK_SHA)" || { echo "SDK checkout is missing; run npm run bridge:setup" >&2; exit 1; }
	@if test "$$(cat $@ 2>/dev/null)" != "$(SDK_SHA)"; then \
		echo "==> SDK revision changed; cleaning for $(SDK_SHA)"; \
		$(MAKE) -C $(SDK) clean && printf '%s\n' "$(SDK_SHA)" > $@; \
	fi

FORCE:

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

clean:
	rm -f $(BIN)

.PHONY: all clean FORCE
