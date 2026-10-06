/*
 *  Slamtec S2E sensor bridge
 *
 *  Connects to an RPLIDAR S2E over UDP using the official Slamtec SDK and
 *  streams complete scan frames as compact little-endian binary to stdout.
 *  Diagnostics go to stderr (unbuffered). The parent process (Electron main)
 *  spawns this, reads stdout, and parses frames.
 *
 *  Wire format (little-endian), one frame per 360 deg revolution:
 *    header (16 bytes):
 *      magic  u32  = 0x534C4944  ('SLID')
 *      seq    u32  monotonically increasing scan index
 *      t_ms   u32  milliseconds since bridge start
 *      count  u32  number of points that follow
 *    points (count * 9 bytes):
 *      angle_deg  f32  0..360
 *      dist_mm    f32  > 0 (invalid / no-return points are dropped)
 *      quality    u8   0..255
 *
 *  Usage: s2e_bridge [ip=192.168.11.2] [port=8089]
 */
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <chrono>
#include <cerrno>
#include <thread>
#include <atomic>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#else
#include <unistd.h>
#endif

#include "sl_lidar.h"
#include "sl_lidar_driver.h"

using namespace sl;

#ifndef _countof
#define _countof(a) (int)(sizeof(a) / sizeof(a[0]))
#endif

static const uint32_t FRAME_MAGIC = 0x534C4944u; // 'SLID'
static const size_t   MAX_NODES   = 8192;

// The stop flag is also written by the stdin watchdog. Lock-free atomics keep
// the signal handler safe without volatile's inter-thread data race.
static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "stop flag must be lock-free");
static std::atomic<bool> g_stop(false);
static std::atomic<bool> g_main_exited(false);
static void on_signal(int) { g_stop.store(true, std::memory_order_relaxed); }

struct MainExitFlag {
    ~MainExitFlag() { g_main_exited.store(true); }
};

static void watch_parent() {
    // Electron leaves stdin open and never writes. Use the raw descriptor so
    // a blocking stdio read cannot hold stdin's lock during CRT shutdown.
    // On Windows, ReadFile also avoids _read's CRT descriptor lock, which
    // closing stdin during normal process shutdown would otherwise need.
    char byte;
#ifdef _WIN32
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
#endif
    for (;;) {
#ifdef _WIN32
        DWORD n = 0;
        if (!ReadFile(input, &byte, 1, &n, nullptr)) break;
#else
        const ssize_t n = read(STDIN_FILENO, &byte, 1);
        if (n < 0 && errno == EINTR) continue;
#endif
        if (n > 0) continue;
        break; // EOF or error: parent closed its pipe or died.
    }
    g_stop.store(true);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!g_main_exited.load() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    // SDK cleanup or a stdout write may still be blocked. _exit bypasses those
    // waits, including during the initial connect/device-info handshake.
    if (!g_main_exited.load()) _exit(0);
}

int main(int argc, const char **argv) {
    MainExitFlag main_exit;
    const char *ip   = (argc > 1) ? argv[1] : "192.168.11.2";
    int         port = (argc > 2) ? atoi(argv[2]) : 8089;

#ifdef _WIN32
    // stdout carries binary frames. Windows defaults stdout to text mode, which
    // can rewrite byte sequences and corrupt the parent parser's frame stream.
    _setmode(_fileno(stdout), _O_BINARY);
#else
    // Ignore SIGPIPE BEFORE any socket I/O. The SDK's connect()/getDeviceInfo()
    // can write to a socket whose peer has gone away (EPIPE); with the default
    // disposition that signal kills us mid-handshake and the parent only ever
    // sees a SIGPIPE exit + endless reconnect. Ignoring it lets those writes
    // fail as -1/EPIPE so the SDK (and our fwrite check below) handle it.
    signal(SIGPIPE, SIG_IGN);
#endif

    // stderr unbuffered so connection logs appear immediately; stdout carries
    // binary frames that we flush explicitly after each scan.
    setvbuf(stderr, nullptr, _IONBF, 0);
    std::thread(watch_parent).detach();
    fprintf(stderr, "[bridge] SDK %s, connecting UDP %s:%d\n", SL_LIDAR_SDK_VERSION, ip, port);

    ILidarDriver *drv = *createLidarDriver();
    if (!drv) { fprintf(stderr, "[bridge] createLidarDriver failed\n"); return 2; }

    IChannel *channel = *createUdpChannel(ip, port);
    if (SL_IS_FAIL(drv->connect(channel))) {
        fprintf(stderr, "[bridge] connect failed to %s:%d\n", ip, port);
        delete drv;
        return 3;
    }

    sl_lidar_response_device_info_t info;
    if (SL_IS_FAIL(drv->getDeviceInfo(info))) {
        // UDP connect() succeeds even with no device present; this is the first
        // real request/response, so a failure here means nothing is answering.
        fprintf(stderr, "[bridge] getDeviceInfo failed - no response from %s:%d (check adapter IP on the sensor's /24 and link: arp -an)\n", ip, port);
        delete drv;
        return 4;
    }
    fprintf(stderr, "[bridge] connected FW %d.%02d HW %d S/N ",
            info.firmware_version >> 8, info.firmware_version & 0xFF, (int)info.hardware_version);
    for (int i = 0; i < 16; ++i) fprintf(stderr, "%02X", info.serialnum[i]);
    fprintf(stderr, "\n");

    sl_lidar_response_device_health_t health;
    if (SL_IS_OK(drv->getHealth(health))) {
        fprintf(stderr, "[bridge] health status=%d\n", health.status);
        if (health.status == SL_LIDAR_STATUS_ERROR) {
            fprintf(stderr, "[bridge] device internal error, exiting\n");
            delete drv;
            return 5;
        }
    }

    // Install stop handlers only now: during the blocking connect/handshake we
    // want the default SIGTERM disposition (immediate exit) so a restart can
    // kill a hung child. On POSIX, SIGPIPE is already ignored from the top of
    // main().
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    LidarScanMode scan_mode = {};
    const sl_result scan_result = drv->startScan(false, true, 0, &scan_mode);
    if (SL_IS_FAIL(scan_result)) {
        fprintf(stderr, "[bridge] startScan failed (0x%08X)\n", (unsigned)scan_result);
        delete drv;
        return 6;
    }
    fprintf(stderr, "[bridge] scanning typical mode id=%u name=%.64s us/sample=%.2f max_distance=%.2f\n",
            (unsigned)scan_mode.id, scan_mode.scan_mode,
            (double)scan_mode.us_per_sample, (double)scan_mode.max_distance);

    const auto t0 = std::chrono::steady_clock::now();
    uint32_t seq = 0;
    sl_lidar_response_measurement_node_hq_t nodes[MAX_NODES];
    static uint8_t framebuf[16 + MAX_NODES * 9];
    int consecutive_failures = 0;
    bool received_frame = false;
    int exit_code = 0;

    while (!g_stop.load()) {
        size_t count = _countof(nodes);
        sl_result op = drv->grabScanDataHq(nodes, count, 1000);
        if (SL_IS_FAIL(op) || count == 0 || count > MAX_NODES) {
            if (g_stop.load()) break;
            const bool startup_expired = std::chrono::steady_clock::now() - t0 >= std::chrono::seconds(8);
            if ((!received_frame && startup_expired) ||
                (received_frame && ++consecutive_failures >= 3)) {
                fprintf(stderr, "[bridge] scan stalled - no data from device, exiting\n");
                exit_code = 4;
                break;
            }
            continue;
        }
        consecutive_failures = 0;
        received_frame = true;
        drv->ascendScanData(nodes, count);

        const uint32_t t_ms = (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - t0).count();

        // Build one frame in a single buffer, then write once.
        size_t off = 16; // reserve header; count filled in after filtering
        uint32_t emitted = 0;
        for (size_t i = 0; i < count; ++i) {
            float dist = nodes[i].dist_mm_q2 / 4.0f;
            if (dist <= 0.0f) continue; // drop no-return / invalid points
            float angle = (nodes[i].angle_z_q14 * 90.0f) / 16384.0f;
            uint8_t q   = nodes[i].quality; // HQ quality is already an 8-bit value.
            memcpy(framebuf + off, &angle, 4); off += 4;
            memcpy(framebuf + off, &dist,  4); off += 4;
            framebuf[off++] = q;
            ++emitted;
        }
        memcpy(framebuf + 0,  &FRAME_MAGIC, 4);
        memcpy(framebuf + 4,  &seq,         4);
        memcpy(framebuf + 8,  &t_ms,        4);
        memcpy(framebuf + 12, &emitted,     4);
        ++seq;

        if (fwrite(framebuf, off, 1, stdout) != 1) break; // parent gone
        if (fflush(stdout) != 0) break; // buffered write failed: parent gone
    }

    fprintf(stderr, "[bridge] stopping\n");
    drv->stop();
    delete drv;
    return exit_code;
}
