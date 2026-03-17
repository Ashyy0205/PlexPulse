import { useState, useEffect } from 'react'
import axios from 'axios'
import client from '../hooks/useApi'

// ── Theme ──────────────────────────────────────────────────────────────────────
const T = {
  card:        '#111114',
  border:      '#1e1e24',
  accent:      '#e5a00d',
  textPrimary: '#f0ede4',
  textMuted:   '#6b6960',
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

// ── Shared components ──────────────────────────────────────────────────────────
function SectionCard({ title, children }) {
  return (
    <div className="rounded-xl p-6 space-y-5"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <h2 className="text-sm font-semibold" style={{ color: T.textPrimary }}>{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium block" style={{ color: T.textMuted }}>{label}</label>
      {children}
      {hint && <p className="text-xs" style={{ color: T.textMuted }}>{hint}</p>}
    </div>
  )
}

function TextInput({ type = 'text', value, onChange, placeholder, ...rest }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded-lg text-sm outline-none"
      style={{ background: '#0d0d10', color: T.textPrimary, border: `1px solid ${T.border}` }}
      {...rest}
    />
  )
}

// ── Inline status feedback ─────────────────────────────────────────────────────
function StatusPill({ status }) {
  if (!status) return null

  if (status === 'saving' || status === 'testing' || status === 'collecting') {
    const label = status === 'saving' ? 'Saving…' : status === 'testing' ? 'Connecting…' : 'Running…'
    return (
      <span className="flex items-center gap-1.5 text-xs" style={{ color: T.textMuted }}>
        <span className="inline-block animate-spin">↻</span>{label}
      </span>
    )
  }

  if (status === 'ok') return (
    <span className="text-xs" style={{ color: '#22c55e' }}>✓ Saved</span>
  )

  if (status.error) return (
    <span className="text-xs" style={{ color: '#f87171' }}>✕ {status.error}</span>
  )

  if (status.ok === true) return (
    <span className="text-xs" style={{ color: '#22c55e' }}>
      ✓ Connected{status.server_name ? ` — ${status.server_name}` : ''}
      {status.version ? ` (Plex ${status.version})` : ''}
    </span>
  )

  if (status.ok === false) return (
    <span className="text-xs" style={{ color: '#f87171' }}>✕ {status.detail || 'Connection failed'}</span>
  )

  if (status.libraries_snapshotted != null) return (
    <span className="text-xs" style={{ color: '#22c55e' }}>
      ✓ Done — {status.libraries_snapshotted} librar{status.libraries_snapshotted !== 1 ? 'ies' : 'y'}
      {status.mounts_snapshotted != null ? `, ${status.mounts_snapshotted} mount${status.mounts_snapshotted !== 1 ? 's' : ''}` : ''} snapshotted
    </span>
  )

  if (typeof status === 'string' && status.startsWith('plex_')) return (
    <span className="text-xs" style={{ color: '#f59e0b' }}>⚠ Saved but Plex connection test failed</span>
  )

  return null
}

// ── Settings page ──────────────────────────────────────────────────────────────
export default function Settings() {
  const [form, setForm] = useState({
    PLEX_URL:            '',
    PLEX_TOKEN:          '',
    COLLECTION_INTERVAL: '6h',
    RETENTION_MONTHS:    '12',
  })
  const [tokenChanged,    setTokenChanged]    = useState(false)
  const [stats,           setStats]           = useState(null)
  const [loading,         setLoading]         = useState(true)
  const [saveStatus,      setSaveStatus]      = useState(null)
  const [testStatus,      setTestStatus]      = useState(null)
  const [collectStatus,   setCollectStatus]   = useState(null)

  useEffect(() => {
    Promise.all([
      client.get('/settings').then(r => r.data).catch(() => ({ settings: {} })),
      client.get('/stats').then(r => r.data).catch(() => null),
    ]).then(([settingsData, statsData]) => {
      const s = settingsData.settings || {}
      setForm({
        PLEX_URL:            s.PLEX_URL            || '',
        PLEX_TOKEN:          '',          // never pre-fill with masked token
        COLLECTION_INTERVAL: s.COLLECTION_INTERVAL || '6h',
        RETENTION_MONTHS:    s.RETENTION_MONTHS    || '12',
      })
      setStats(statsData)
      setLoading(false)
    })
  }, [])

  const set = (key, val) => {
    setForm(f => ({ ...f, [key]: val }))
    if (key === 'PLEX_TOKEN') setTokenChanged(true)
  }

  const handleTestConnection = async () => {
    setTestStatus('testing')
    if (form.PLEX_URL && form.PLEX_TOKEN) {
      try {
        const res = await client.post('/test-connection', {
          plex_url:   form.PLEX_URL,
          plex_token: form.PLEX_TOKEN,
        })
        setTestStatus(res.data)
      } catch (e) {
        setTestStatus({ ok: false, detail: e?.response?.data?.detail ?? e.message })
      }
    } else {
      // No new creds entered — check current live status
      try {
        const res = await axios.get('/health')
        setTestStatus({
          ok:          res.data.plex_connected,
          server_name: undefined,
          detail:      res.data.plex_connected ? undefined : 'Plex is offline. Enter URL and Token to test new credentials.',
        })
      } catch {
        setTestStatus({ ok: false, detail: 'Could not reach backend.' })
      }
    }
  }

  const handleSave = async () => {
    setSaveStatus('saving')
    setTestStatus(null)
    const payload = {
      PLEX_URL:            form.PLEX_URL,
      COLLECTION_INTERVAL: form.COLLECTION_INTERVAL,
      RETENTION_MONTHS:    form.RETENTION_MONTHS,
    }
    if (tokenChanged && form.PLEX_TOKEN) {
      payload.PLEX_TOKEN = form.PLEX_TOKEN
    }
    try {
      const res = await client.put('/settings', { settings: payload })
      const d = res.data
      if (d.plex_reconnected && d.plex_connection_ok === false) {
        setSaveStatus('plex_warn')
      } else {
        setSaveStatus('ok')
      }
      setTokenChanged(false)
      setTimeout(() => setSaveStatus(null), 4000)
    } catch (e) {
      setSaveStatus({ error: e?.response?.data?.detail ?? e.message })
    }
  }

  const handleCollect = async () => {
    setCollectStatus('collecting')
    try {
      const res = await client.post('/collect')
      setCollectStatus(res.data)
      setTimeout(() => setCollectStatus(null), 6000)
    } catch (e) {
      setCollectStatus({ error: e?.response?.data?.detail ?? e.message })
    }
  }

  if (loading) return (
    <div className="space-y-5">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="rounded-xl p-6 space-y-4"
          style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <div className="h-4 w-32 animate-pulse rounded bg-[#1e1e24]" />
          {[...Array(2)].map((_, j) => (
            <div key={j} className="h-9 animate-pulse rounded bg-[#1e1e24]" />
          ))}
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-5 pb-6" style={{ color: T.textPrimary }}>

      {/* 1 — Plex Connection */}
      <SectionCard title="Plex Connection">
        <Field label="Server URL" hint="e.g. http://192.168.1.100:32400 — must be reachable from the PlexPulse container">
          <TextInput
            value={form.PLEX_URL}
            onChange={v => set('PLEX_URL', v)}
            placeholder="http://192.168.1.100:32400"
          />
        </Field>

        <Field label="Plex Token" hint="Leave blank to keep the existing token unchanged">
          <TextInput
            type="password"
            value={form.PLEX_TOKEN}
            onChange={v => set('PLEX_TOKEN', v)}
            placeholder="Enter new token to update"
            autoComplete="new-password"
          />
        </Field>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleTestConnection}
            disabled={testStatus === 'testing'}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50"
            style={{ background: T.border, color: T.textPrimary }}>
            Test Connection
          </button>
          <StatusPill status={testStatus} />
        </div>
      </SectionCard>

      {/* 2 — Collection */}
      <SectionCard title="Collection">
        <Field label="Collection Interval" hint="How often PlexPulse snapshots your libraries and mount points">
          <select
            value={form.COLLECTION_INTERVAL}
            onChange={e => set('COLLECTION_INTERVAL', e.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
            style={{ background: '#0d0d10', color: T.textPrimary, border: `1px solid ${T.border}` }}>
            {[['1h','1 hour'],['3h','3 hours'],['6h','6 hours'],['12h','12 hours'],['24h','24 hours']].map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </Field>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleCollect}
            disabled={collectStatus === 'collecting'}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-2"
            style={{ background: T.border, color: T.textPrimary }}>
            {collectStatus === 'collecting'
              ? <><span className="inline-block animate-spin">↻</span> Running…</>
              : 'Run Collection Now'
            }
          </button>
          <StatusPill status={collectStatus} />
        </div>
      </SectionCard>

      {/* 3 — Data & Storage */}
      <SectionCard title="Data & Storage">
        {stats && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg p-3 space-y-1" style={{ background: '#0d0d10' }}>
              <div className="text-xs font-medium" style={{ color: T.textMuted }}>Database Size</div>
              <div className="text-lg font-bold tabular-nums" style={{ color: T.textPrimary }}>
                {fmtBytes(stats.db_size_bytes)}
              </div>
            </div>
            <div className="rounded-lg p-3 space-y-1" style={{ background: '#0d0d10' }}>
              <div className="text-xs font-medium" style={{ color: T.textMuted }}>Total Snapshots</div>
              <div className="text-lg font-bold tabular-nums" style={{ color: T.textPrimary }}>
                {(stats.snapshot_count ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
        )}

        <Field
          label="Retention Period"
          hint="Snapshots older than this will be pruned during collection (0 = keep forever)"
        >
          <div className="flex gap-2 items-center">
            <TextInput
              type="number"
              min={0}
              max={120}
              value={form.RETENTION_MONTHS}
              onChange={v => set('RETENTION_MONTHS', v)}
              placeholder="12"
            />
            <span className="text-sm flex-shrink-0" style={{ color: T.textMuted }}>months</span>
          </div>
        </Field>
      </SectionCard>

      {/* Save footer */}
      <div className="flex items-center justify-end gap-4">
        <StatusPill status={saveStatus} />
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
          style={{ background: T.accent, color: '#000' }}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save Settings'}
        </button>
      </div>

    </div>
  )
}
