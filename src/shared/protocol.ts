// Wire format shared between the C++ bridge (producer) and Electron main (parser).
// One frame per 360-degree scan revolution, little-endian:
//   header (16 bytes): magic u32 = 'SLID', seq u32, t_ms u32, count u32
//   points (count * 9 bytes): angle_deg f32, dist_mm f32, quality u8
export const FRAME_MAGIC = 0x534c4944 // 'SLID'
export const HEADER_BYTES = 16
export const POINT_BYTES = 9
// Sanity cap used to detect stream desync (a real S2 scan is ~2k-3.5k points).
export const MAX_POINTS = 20000
