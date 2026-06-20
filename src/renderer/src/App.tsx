import { useEffect, useState } from 'react'
import type { BridgeStatus } from '@shared/types'
import LidarCanvas from './components/LidarCanvas'

const STATE_COLOR: Record<string, string> = {
  idle: '#8a93a6',
  connecting: '#e0b341',
  connected: '#37a0d4',
  scanning: '#3ad48c',
  error: '#ff5d5d',
  stopped: '#8a93a6'
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>({ state: 'idle' })
  const [ip, setIp] = useState('192.168.11.2')
  const [port, setPort] = useState(8089)

  useEffect(() => {
    return window.api?.onStatus(setStatus)
  }, [])

  const color = STATE_COLOR[status.state] ?? '#8a93a6'

  return (
    <div className="app">
      <header className="topbar">
        <strong>Slamtec&nbsp;S2E&nbsp;Tracker</strong>
        <span className="pill" style={{ color, borderColor: color }}>
          ● {status.state}
          {status.message ? ` — ${status.message}` : ''}
        </span>
        <div className="spacer" />
        <label className="field">
          IP
          <input value={ip} onChange={(e) => setIp(e.target.value)} style={{ width: 130 }} />
        </label>
        <label className="field">
          Port
          <input
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 0)}
            style={{ width: 70 }}
          />
        </label>
        <button onClick={() => window.api?.start({ ip, port })}>Start</button>
        <button className="ghost" onClick={() => window.api?.stop()}>
          Stop
        </button>
      </header>
      <div className="canvas-wrap">
        <LidarCanvas />
      </div>
    </div>
  )
}
