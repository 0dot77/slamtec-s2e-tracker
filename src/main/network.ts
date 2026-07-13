import * as os from 'node:os'
import * as dgram from 'node:dgram'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  NetworkInterfaceInfo,
  NetworkDiagnosis,
  DeviceProbeResult,
  NetworkConfigureRequest,
  NetworkConfigureResult
} from '../shared/types'

/**
 * Host-side network diagnosis, ARP device probing, and one-click elevated
 * adapter configuration for the LiDAR's fixed /24. Dependency-free: only
 * node:os, node:dgram, and node:child_process (arp / networksetup / osascript /
 * netsh / powershell are all stock binaries on their respective platforms).
 *
 * Rationale for the design lives in the plan; the load-bearing constraints are
 * noted inline where they are non-obvious (unconfigured adapters carry no IPv4,
 * the S2E answers no ICMP so presence is ARP-only, RunAs detaches so the
 * elevated exit code cannot be trusted — re-diagnosis polling is the sole
 * source of `ok`).
 */

const execFileAsync = promisify(execFile)

// --- subnet helpers ---------------------------------------------------------

// True when both addresses share the first three octets (a /24 match).
function sameSubnet24(a: string, b: string): boolean {
  const pa = a.split('.')
  const pb = b.split('.')
  if (pa.length !== 4 || pb.length !== 4) return false
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2]
}

function subnet24(ip: string): string {
  return ip.split('.').slice(0, 3).join('.')
}

// --- macOS network service map ---------------------------------------------

interface ServiceEntry {
  service: string
  isWifi: boolean
  enabled: boolean
}

// networksetup -listnetworkserviceorder is stable but slow-ish; diagnose() runs
// in a reconnect loop, so cache the parsed device->service map for ~10s.
let serviceMapCache: { map: Map<string, ServiceEntry>; at: number } | null = null
const SERVICE_MAP_TTL_MS = 10_000

/**
 * Parses `networksetup -listnetworkserviceorder`. Each service block looks like:
 *
 *   (3) USB 10/100/1000 LAN
 *   (Hardware Port: USB 10/100/1000 LAN, Device: en5)
 *
 * A `(*)` prefix instead of a number marks a disabled service. Returns a
 * Device -> {service, isWifi, enabled} map. Empty on any failure (e.g. non-darwin).
 */
async function loadServiceMap(force = false): Promise<Map<string, ServiceEntry>> {
  const now = Date.now()
  if (!force && serviceMapCache && now - serviceMapCache.at < SERVICE_MAP_TTL_MS) {
    return serviceMapCache.map
  }
  const map = new Map<string, ServiceEntry>()
  try {
    const { stdout } = await execFileAsync('networksetup', ['-listnetworkserviceorder'])
    const lines = stdout.split('\n')
    for (let i = 0; i < lines.length; i++) {
      // Match the service-name line: "(3) Name" (enabled) or "(*) Name" (disabled).
      const header = lines[i].match(/^\((\*|\d+)\)\s+(.*)$/)
      if (!header) continue
      const enabled = header[1] !== '*'
      const service = header[2].trim()
      // The detail line follows immediately.
      const detail = lines[i + 1] ?? ''
      const dm = detail.match(/Hardware Port:\s*(.*?),\s*Device:\s*([^)]*)\)/)
      if (!dm) continue
      const hardwarePort = dm[1].trim()
      const device = dm[2].trim()
      if (!device) continue
      const isWifi = /Wi-?Fi|AirPort/i.test(hardwarePort) || /Wi-?Fi|AirPort/i.test(service)
      map.set(device, { service, isWifi, enabled })
    }
  } catch {
    // No networksetup (non-darwin) or command failure: empty map.
  }
  serviceMapCache = { map, at: now }
  return map
}

// Hardware ports that are never the LiDAR adapter even if they enumerate.
function isExcludedHardwarePort(port: string | undefined): boolean {
  if (!port) return false
  return /Bluetooth|Thunderbolt Bridge|VPN/i.test(port)
}

// --- diagnose ---------------------------------------------------------------

function ipv4Of(addrs: os.NetworkInterfaceInfo[] | undefined): string[] {
  if (!addrs) return []
  return addrs.filter((a) => a.family === 'IPv4').map((a) => a.address)
}

function isLinkLocal(ipv4: string[]): boolean {
  return ipv4.some((ip) => ip.startsWith('169.254.'))
}

// darwin device names that are structurally never the target adapter.
const DARWIN_EXCLUDE = /^(lo|utun|awdl|llw|bridge|gif|stf|ap\d|anpi|vmenet)/
// win32 alias fragments that mark a virtual / wireless / non-target adapter.
const WIN_EXCLUDE = /loopback|vEthernet|VMware|VirtualBox|TAP|Bluetooth|Wi-?Fi|WLAN|무선/i

function isVirtualName(name: string, platform: string): boolean {
  if (platform === 'win32') {
    return /vEthernet|VMware|VirtualBox|TAP|Hyper-V|Loopback/i.test(name)
  }
  return /^(utun|bridge|gif|stf|vmenet|llw|awdl|ap\d|anpi)/.test(name)
}

export async function diagnose(targetIp: string): Promise<NetworkDiagnosis> {
  const platform = process.platform
  const serviceMap = platform === 'darwin' ? await loadServiceMap() : new Map<string, ServiceEntry>()
  const ifaces = os.networkInterfaces()

  const all: NetworkInterfaceInfo[] = []

  for (const [name, addrs] of Object.entries(ifaces)) {
    // Skip only loopback/internal; keep interfaces with no IPv4 — unconfigured
    // USB adapters commonly carry only an fe80:: link-local entry.
    if (addrs && addrs.every((a) => a.internal)) continue

    const ipv4 = ipv4Of(addrs)
    const linkLocal = isLinkLocal(ipv4)
    const virtual = isVirtualName(name, platform)
    const onTargetSubnet = ipv4.some((ip) => sameSubnet24(ip, targetIp))

    let serviceName: string | undefined
    let isWifi = false
    let excludedHwPort = false

    if (platform === 'darwin') {
      const entry = serviceMap.get(name)
      if (entry) {
        serviceName = entry.service
        isWifi = entry.isWifi
        // Reconstruct the hardware-port style check from the service name for
        // the Bluetooth/Thunderbolt/VPN exclusion.
        excludedHwPort = isExcludedHardwarePort(entry.service)
      }
    }

    // Candidate filtering, per platform.
    let candidate: boolean
    if (platform === 'darwin') {
      candidate = !DARWIN_EXCLUDE.test(name) && !isWifi && !excludedHwPort
    } else if (platform === 'win32') {
      candidate = !WIN_EXCLUDE.test(name)
    } else {
      candidate = !virtual
    }

    all.push({
      name,
      serviceName,
      ipv4,
      isWifi,
      isVirtual: virtual,
      isLinkLocal: linkLocal,
      onTargetSubnet,
      candidate,
      suggested: false
    })
  }

  const matches = all.filter((i) => i.onTargetSubnet)
  // Candidates already on the subnet need no configuration, so drop them here.
  const candidates = all.filter((i) => i.candidate && !i.onTargetSubnet)

  // Rank candidates: (1) 169.254.x present, (2) name/service reads USB/LAN/
  // Ethernet/이더넷, (3) no IPv4 at all, (4) everything else. Exactly one gets
  // suggested=true (the best-ranked).
  const rankOf = (i: NetworkInterfaceInfo): number => {
    if (i.isLinkLocal) return 0
    const label = `${i.name} ${i.serviceName ?? ''}`
    if (/USB|LAN|Ethernet|이더넷/i.test(label)) return 1
    if (i.ipv4.length === 0) return 2
    return 3
  }
  const ranked = [...candidates].sort((a, b) => rankOf(a) - rankOf(b))
  if (ranked.length > 0) {
    const best = ranked[0]
    const chosen = candidates.find((c) => c.name === best.name)
    if (chosen) chosen.suggested = true
  }

  return {
    targetIp,
    ok: matches.length > 0,
    matches,
    candidates: ranked,
    all,
    platform
  }
}

// --- probeDevice ------------------------------------------------------------

function hostOwnIpv4(): Set<string> {
  const own = new Set<string>()
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4') own.add(a.address)
    }
  }
  return own
}

// Fire one small UDP datagram at targetIp:8089 to force OS ARP resolution, then
// close the socket. The datagram is never answered (the point is the ARP
// request the kernel emits to route it); we resolve regardless of send errors.
function nudgeArp(targetIp: string, port = 8089): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      try {
        sock.close()
      } catch {
        // already closed
      }
      resolve()
    }
    const sock = dgram.createSocket('udp4')
    sock.on('error', done)
    try {
      sock.send(Buffer.from([0]), port, targetIp, () => done())
    } catch {
      done()
    }
  })
}

function isValidMac(mac: string): boolean {
  const m = mac.toLowerCase()
  if (m.includes('incomplete')) return false
  if (m === 'ff-ff-ff-ff-ff-ff' || m === 'ff:ff:ff:ff:ff:ff') return false
  return /^([0-9a-f]{1,2})([:-][0-9a-f]{1,2}){5}$/.test(m)
}

// darwin: `? (192.168.11.2) at aa:bb:cc:dd:ee:ff on en5 ...`; "(incomplete)" MAC.
function parseArpDarwin(stdout: string): Map<string, string> {
  const table = new Map<string, string>()
  const re = /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:]+|\(incomplete\))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stdout)) !== null) {
    table.set(m[1], m[2])
  }
  return table
}

// win32: ignore locale headers; extract rows of "IP  MAC(xx-xx-...)". Global,
// case-insensitive, multiline.
function parseArpWin(stdout: string): Map<string, string> {
  const table = new Map<string, string>()
  const re = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/gim
  let m: RegExpExecArray | null
  while ((m = re.exec(stdout)) !== null) {
    table.set(m[1], m[2])
  }
  return table
}

export async function probeDevice(targetIp: string): Promise<DeviceProbeResult> {
  await nudgeArp(targetIp)
  await new Promise((r) => setTimeout(r, 700))

  let table = new Map<string, string>()
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('arp', ['-a'])
      table = parseArpWin(stdout)
    } else {
      const { stdout } = await execFileAsync('arp', ['-an'])
      table = parseArpDarwin(stdout)
    }
  } catch {
    // arp unavailable / failed: treat as no device seen.
  }

  const own = hostOwnIpv4()
  const targetMac = table.get(targetIp)
  const found = !!targetMac && isValidMac(targetMac)

  // otherIps: other valid /24 entries, excluding the target, our own addresses,
  // x.x.x.255 broadcast, and 224.0.0.0+ multicast. .1 gateway-looking entries
  // stay in — the UI treats them as suggestions only.
  const otherIps: string[] = []
  for (const [ip, mac] of table) {
    if (ip === targetIp) continue
    if (!isValidMac(mac)) continue
    if (!sameSubnet24(ip, targetIp)) continue
    if (own.has(ip)) continue
    if (ip.endsWith('.255')) continue
    const first = Number(ip.split('.')[0])
    if (first >= 224) continue
    otherIps.push(ip)
  }

  return { found, probedIp: targetIp, otherIps }
}

// --- configure --------------------------------------------------------------

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function isValidIp(ip: string): boolean {
  if (!IP_RE.test(ip)) return false
  return ip.split('.').every((o) => Number(o) <= 255)
}

// Repeated diagnose() until the target /24 has an interface or we time out. The
// result is the SOLE source of truth for configure()'s `ok`.
async function pollUntilOnSubnet(
  targetIp: string,
  timeoutMs = 15_000,
  intervalMs = 750
): Promise<NetworkDiagnosis> {
  const deadline = Date.now() + timeoutMs
  let diag = await diagnose(targetIp)
  while (!diag.ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    diag = await diagnose(targetIp)
  }
  return diag
}

async function configureMac(
  req: NetworkConfigureRequest,
  mask: string
): Promise<NetworkConfigureResult> {
  // Resolve the service name from a fresh (uncached) service map — the map may
  // have gone stale, and configuration must not act on a wrong service.
  const serviceMap = await loadServiceMap(true)
  const entry = serviceMap.get(req.interfaceName)
  if (!entry || !entry.enabled) {
    return {
      ok: false,
      cancelled: false,
      error: 'no-network-service',
      diagnosis: await diagnose(req.ip)
    }
  }
  const service = entry.service
  // A service name with a double quote would break the AppleScript literal.
  if (service.includes('"')) {
    return {
      ok: false,
      cancelled: false,
      error: 'invalid-service-name',
      diagnosis: await diagnose(req.ip)
    }
  }

  // Build the AppleScript. The service name is embedded via JSON.stringify so it
  // becomes a correctly-escaped AppleScript string literal, then wrapped in
  // `quoted form of` for the shell. ip/mask are pre-validated numeric dotted
  // quads, safe to inline.
  const script =
    'do shell script "networksetup -setmanual " & quoted form of ' +
    JSON.stringify(service) +
    ` & " ${req.ip} ${mask}" with administrator privileges` +
    ' with prompt "Configure the LiDAR network adapter"'

  let cancelled = false
  try {
    await execFileAsync('osascript', ['-e', script])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '')
    if (/User canceled|-128/.test(stderr)) cancelled = true
    // Any other failure falls through to polling, which decides `ok`.
  }

  // Even on suspected cancel, re-diagnose: the poll is the sole `ok` source.
  const diagnosis = await pollUntilOnSubnet(req.ip)
  return { ok: diagnosis.ok, cancelled: cancelled && !diagnosis.ok, error: undefined, diagnosis }
}

async function configureWin(
  req: NetworkConfigureRequest,
  mask: string
): Promise<NetworkConfigureResult> {
  const alias = req.interfaceName
  // A double quote in the alias would break the name="..." netsh argument.
  if (alias.includes('"')) {
    return {
      ok: false,
      cancelled: false,
      error: 'invalid-interface-name',
      diagnosis: await diagnose(req.ip)
    }
  }

  // Escape single quotes for the PowerShell single-quoted argument list by
  // doubling them. The alias may be Korean / contain spaces — passed as one arg.
  const aliasPs = alias.replace(/'/g, "''")
  const cmd =
    `$p = Start-Process -FilePath netsh -ArgumentList ` +
    `'interface','ip','set','address','name="${aliasPs}"','static','${req.ip}','${mask}' ` +
    `-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`

  const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

  let cancelled = false
  try {
    await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', cmd])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '')
    // UAC cancel makes Start-Process throw; treat as a fast-fail signal only.
    if (/cancell?ed|취소/i.test(stderr)) cancelled = true
  }

  const diagnosis = await pollUntilOnSubnet(req.ip)
  return { ok: diagnosis.ok, cancelled: cancelled && !diagnosis.ok, error: undefined, diagnosis }
}

export async function configure(req: NetworkConfigureRequest): Promise<NetworkConfigureResult> {
  if (!isValidIp(req.ip)) {
    return { ok: false, cancelled: false, error: 'invalid-ip', diagnosis: await diagnose(req.ip) }
  }
  // Only /24 is supported for now.
  if (req.prefixLength !== 24) {
    return {
      ok: false,
      cancelled: false,
      error: 'unsupported-prefix',
      diagnosis: await diagnose(req.ip)
    }
  }
  const mask = '255.255.255.0'

  if (process.platform === 'darwin') return configureMac(req, mask)
  if (process.platform === 'win32') return configureWin(req, mask)

  return {
    ok: false,
    cancelled: false,
    error: 'unsupported-platform',
    diagnosis: await diagnose(req.ip)
  }
}
