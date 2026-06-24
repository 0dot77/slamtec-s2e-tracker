# Builds the S2E sensor bridge against the prebuilt Slamtec SDK static lib.
# `npm run bridge:setup` fetches the SDK and builds this target.

SDK     := third_party/rplidar_sdk
SDK_INC := -I$(SDK)/sdk/include -I$(SDK)/sdk/src
UNAME_S := $(shell uname -s)
SDK_PLATFORM := $(if $(filter Darwin,$(UNAME_S)),Darwin,Linux)
SDK_LIB := $(SDK)/output/$(SDK_PLATFORM)/Release/libsl_lidar_sdk.a

CXX      := clang++
CXXFLAGS := -std=c++11 -O2 -Wall $(SDK_INC)
LDFLAGS  := -lstdc++ -lpthread

BIN_DIR := bin
BIN := $(BIN_DIR)/s2e_bridge

all: $(BIN)

$(BIN): src/main.cpp $(SDK_LIB) | $(BIN_DIR)
	$(CXX) $(CXXFLAGS) -o $(BIN) src/main.cpp $(SDK_LIB) $(LDFLAGS)

$(SDK_LIB):
	$(MAKE) -C $(SDK)

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

clean:
	rm -f $(BIN)

.PHONY: all clean
