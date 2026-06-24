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

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "sl_lidar.h"
#include "sl_lidar_driver.h"

using namespace sl;

#ifndef _countof
#define _countof(a) (int)(sizeof(a) / sizeof(a[0]))
#endif

static const uint32_t FRAME_MAGIC = 0x534C4944u; // 'SLID'
static const size_t   MAX_NODES   = 8192;

static volatile sig_atomic_t g_stop = 0;
static void on_signal(int) { g_stop = 1; }

int main(int argc, const char **argv) {
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
        fprintf(stderr, "[bridge] getDeviceInfo failed\n");
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

    drv->startScan(0, 1); // force=0, useTypicalScan=1
    fprintf(stderr, "[bridge] scanning\n");

    const auto t0 = std::chrono::steady_clock::now();
    uint32_t seq = 0;
    sl_lidar_response_measurement_node_hq_t nodes[MAX_NODES];
    static uint8_t framebuf[16 + MAX_NODES * 9];

    while (!g_stop) {
        size_t count = _countof(nodes);
        sl_result op = drv->grabScanDataHq(nodes, count);
        if (SL_IS_FAIL(op)) continue;
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
            uint8_t q   = (uint8_t)(nodes[i].quality >> SL_LIDAR_RESP_MEASUREMENT_QUALITY_SHIFT);
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
        fflush(stdout);
    }

    fprintf(stderr, "[bridge] stopping\n");
    drv->stop();
    delete drv;
    return 0;
}
