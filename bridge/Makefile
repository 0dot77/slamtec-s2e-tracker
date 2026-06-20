# Builds the S2E sensor bridge against the prebuilt Slamtec SDK static lib.
# Run `make` inside third_party/rplidar_sdk first (produces libsl_lidar_sdk.a).

SDK     := third_party/rplidar_sdk
SDK_INC := -I$(SDK)/sdk/include -I$(SDK)/sdk/src
SDK_LIB := $(SDK)/output/Darwin/Release/libsl_lidar_sdk.a

CXX      := clang++
CXXFLAGS := -std=c++11 -O2 -Wall $(SDK_INC)
LDFLAGS  := -lstdc++ -lpthread

BIN := s2e_bridge

all: $(BIN)

$(BIN): src/main.cpp $(SDK_LIB)
	$(CXX) $(CXXFLAGS) -o $(BIN) src/main.cpp $(SDK_LIB) $(LDFLAGS)

$(SDK_LIB):
	$(MAKE) -C $(SDK)

clean:
	rm -f $(BIN)

.PHONY: all clean
