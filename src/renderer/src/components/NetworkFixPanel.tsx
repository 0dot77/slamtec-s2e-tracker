import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DeviceProbeResult,
  NetworkDiagnosis,
  NetworkInterfaceInfo
} from '@shared/types'

// The S2E's factory address. We configure the host adapter onto this /24.
const HOST_IP = '192.168.11.100'
const PREFIX = 24

// Internal flow. `checking` runs the initial diagnosis; `needs-fix` is the
// choose-an-adapter state; `configuring` covers the admin/UAC prompt; then
// `verifying` polls (done inside configure) before landing on a terminal state.
type Phase =
  | 'checking'
  | 'needs-fix'
  | 'configuring'
  | 'verifying'
  | 'fixed'
  | 'failed'
  | 'cancelled'

interface NetworkFixPanelProps {
  targetIp: string
  onFixed: () => void
  onStartAnyway: () => void
  onDismiss: () => void
}

// Per-platform manual fallback commands, mirrored from README.md.
const IS_WIN =
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent)

function ifaceLabel(iface: NetworkInterfaceInfo): string {
  const addr = iface.ipv4[0] ?? 'no address'
  const selfAssigned = iface.isLinkLocal ? ' self-assigned' : ''
  const svc = iface.serviceName ? ` — ${iface.serviceName}` : ''
  return `${iface.name}${svc} (${addr}${selfAssigned})`
}

export default function NetworkFixPanel({
  targetIp,
  onFixed,
  onStartAnyway,
  onDismiss
}: NetworkFixPanelProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('checking')
  const [diag, setDiag] = useState<NetworkDiagnosis | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [note, setNote] = useState<string>('')
  const [probe, setProbe] = useState<DeviceProbeResult | null>(null)
  // macOS candidate with no network service — needs manual add in System Settings.
  const [noService, setNoService] = useState(false)

  const busy = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const targetRef = useRef(targetIp)
  targetRef.current = targetIp
  const onFixedRef = useRef(onFixed)
  onFixedRef.current = onFixed
  const invalidate = (): void => { generation.current += 1; busy.current = false }
  const isCurrent = (token: number, target: string): boolean =>
    mounted.current && generation.current === token && targetRef.current === target

  const recheck = useCallback(async (): Promise<void> => {
    const token = ++generation.current
    busy.current = true
    setPhase('checking')
    setNote('')
    setNoService(false)
    setProbe(null)
    try {
      const d = await window.api?.diagnoseNetwork(targetIp)
      if (!isCurrent(token, targetIp)) return
      if (!d) {
        setPhase('failed')
        setNote('Diagnosis unavailable.')
        return
      }
      setDiag(d)
      // Preselect the suggested candidate, else the first one.
      const pick = d.candidates.find((c) => c.suggested) ?? d.candidates[0]
      setSelected(pick?.name ?? '')
      setPhase('needs-fix')
    } catch (e) {
      if (!isCurrent(token, targetIp)) return
      setPhase('failed')
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      if (isCurrent(token, targetIp)) busy.current = false
    }
  }, [targetIp])

  useEffect(() => {
    mounted.current = true
    void recheck()
    return () => {
      mounted.current = false
      generation.current += 1
      busy.current = false
    }
  }, [recheck])

  const configure = useCallback(async (): Promise<void> => {
    if (busy.current || !selected) return
    const token = ++generation.current
    busy.current = true
    setPhase('configuring')
    setNote(IS_WIN ? 'Windows will show a UAC prompt…' : 'Waiting for the admin password…')
    setNoService(false)
    try {
      const res = await window.api?.configureNetwork({
        interfaceName: selected,
        ip: HOST_IP,
        prefixLength: PREFIX
      })
      if (!isCurrent(token, targetIp)) return
      if (!res) {
        setPhase('failed')
        setNote('Configuration failed.')
        return
      }
      if (res.diagnosis) setDiag(res.diagnosis)

      if (res.cancelled) {
        setPhase('cancelled')
        setNote('Admin prompt was cancelled — nothing changed.')
        return
      }
      if (res.error === 'no-network-service') {
        setNoService(true)
        setPhase('failed')
        setNote(
          'This adapter has no macOS network service yet. Open System Settings → Network → + and add it, then Re-check.'
        )
        return
      }
      if (!res.ok) {
        setPhase('failed')
        setNote(res.error ? `Could not verify the change: ${res.error}` : 'Could not verify the change.')
        return
      }

      // Adapter is on the subnet. Confirm the device is actually reachable; if
      // not, the device may live at a different address on the same /24.
      setPhase('verifying')
      setNote('Adapter configured. Looking for the LiDAR…')
      const p = await window.api?.probeDevice(targetIp)
      if (!isCurrent(token, targetIp)) return
      setProbe(p ?? null)
      setPhase('fixed')
      setNote('Adapter set to 192.168.11.100. Connecting…')
      onFixedRef.current()
    } catch (e) {
      if (!isCurrent(token, targetIp)) return
      setPhase('failed')
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      if (isCurrent(token, targetIp)) busy.current = false
    }
  }, [selected, targetIp])

  const matches = diag?.matches ?? []
  const candidates = diag?.candidates ?? []

  return (
    <div className="net-banner" role="region" aria-label="Network setup">
      <div className="net-row net-head">
        <strong>No LiDAR network adapter found</strong>
        <span className="net-sub">The S2E lives at {targetIp} — a host adapter must share that subnet.</span>
        <div className="net-spacer" />
        <button type="button" className="net-x" onClick={() => { invalidate(); onDismiss() }} title="Dismiss">
          ✕
        </button>
      </div>

      {matches.length > 0 && (
        <div className="net-ok">
          {matches.map((m) => (
            <div key={m.name} className="net-ok-row">
              ✓ {ifaceLabel(m)}
            </div>
          ))}
          {matches.length > 1 && (
            <div className="net-warn">
              Multiple adapters share this subnet — unplug the extras if the connection is unstable.
            </div>
          )}
        </div>
      )}

      {(phase === 'needs-fix' ||
        phase === 'configuring' ||
        phase === 'verifying' ||
        phase === 'failed' ||
        phase === 'cancelled') && (
        <div className="net-fix">
          {candidates.length > 0 ? (
            <>
              <label className="net-field">
                Adapter
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  disabled={phase === 'configuring' || phase === 'verifying'}
                >
                  {candidates.map((c) => (
                    <option key={c.name} value={c.name}>
                      {ifaceLabel(c)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="net-primary"
                onClick={configure}
                disabled={phase === 'configuring' || phase === 'verifying' || !selected}
              >
                {IS_WIN
                  ? 'Set this adapter to 192.168.11.100 (Windows will show a UAC prompt)'
                  : 'Set this adapter to 192.168.11.100 (asks for admin password)'}
              </button>
            </>
          ) : (
            <div className="net-sub">No configurable adapter detected. Plug in the USB-LAN adapter and Re-check.</div>
          )}
        </div>
      )}

      {phase === 'checking' && <div className="net-sub">Checking network adapters…</div>}

      {note && (
        <div className={phase === 'failed' || phase === 'cancelled' ? 'net-warn' : 'net-sub'}>{note}</div>
      )}

      {noService && (
        <div className="net-guide">
          <button
            type="button"
            className="net-ghost"
            onClick={() =>
              window.open('x-apple.systempreferences:com.apple.Network-Settings.extension', '_blank')
            }
          >
            Open Network settings
          </button>
        </div>
      )}

      {/* Device found at a different address on the same subnet. */}
      {probe && !probe.found && probe.otherIps.length > 0 && (
        <div className="net-suggest">
          <div className="net-sub">A device responded on this subnet — connect to it instead:</div>
          {probe.otherIps.map((otherIp) => (
            <button
              key={otherIp}
              type="button"
              className="net-ghost"
              onClick={() => window.api?.start({ ip: otherIp })}
            >
              Connect to {otherIp}
            </button>
          ))}
        </div>
      )}

      <div className="net-actions">
        <button type="button" className="net-ghost" onClick={recheck} disabled={phase === 'checking'}>
          Re-check
        </button>
        <button type="button" className="net-ghost" onClick={() => { invalidate(); onStartAnyway() }}>
          Start anyway
        </button>
      </div>

      <div className="net-note">
        Configuring makes that adapter dedicated to the LiDAR — it will have no internet.
      </div>

      <details className="net-manual">
        <summary>Do it manually</summary>
        {IS_WIN ? (
          <pre>
{`Get-NetAdapter
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.11.100 -PrefixLength 24
arp -a | findstr 192.168.11.2`}
          </pre>
        ) : (
          <pre>
{`networksetup -listallnetworkservices
networksetup -setmanual "USB 10/100/1000 LAN" 192.168.11.100 255.255.255.0
arp -an | grep 192.168.11.2`}
          </pre>
        )}
        {IS_WIN && (
          <div className="net-sub">
            Windows Firewall may prompt on the first UDP packet — allow it.
          </div>
        )}
      </details>
    </div>
  )
}
