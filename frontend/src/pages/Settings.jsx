import { useState, useEffect, useRef } from 'react'
import client from '../hooks/useApi'
import { useToast } from '../components/Toast'

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
    COLLECTION_INTERVAL: '6h',
    RETENTION_MONTHS:    '12',
  })
  const [stats,           setStats]           = useState(null)
  const [loading,         setLoading]         = useState(true)
  const [saveStatus,      setSaveStatus]      = useState(null)
  const [collectStatus,   setCollectStatus]   = useState(null)

  // OAuth flow state
  const [plexAuthState, setPlexAuthState] = useState('disconnected') // 'disconnected' | 'waiting' | 'connected'
  const [serverName,    setServerName]    = useState('')
  const [maskedToken,   setMaskedToken]   = useState('')
  const pollRef      = useRef(null)
  const pollCountRef = useRef(0)

  const addToast = useToast()

  // Stop polling (safe to call multiple times)
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // Clear polling on unmount
  useEffect(() => () => stopPolling(), [])

  useEffect(() => {
    Promise.all([
      client.get('/settings').then(r => r.data).catch(() => ({ settings: {} })),
      client.get('/stats').then(r => r.data).catch(() => null),
    ]).then(([settingsData, statsData]) => {
      const s = settingsData.settings || {}
      setForm({
        PLEX_URL:            s.PLEX_URL            || '',
        COLLECTION_INTERVAL: s.COLLECTION_INTERVAL || '6h',
        RETENTION_MONTHS:    s.RETENTION_MONTHS    || '12',
      })
      setStats(statsData)
      if (s.PLEX_TOKEN) {
        setPlexAuthState('connected')
        setMaskedToken(s.PLEX_TOKEN)
        setServerName(s.PLEX_SERVER_NAME || '')
      }
      setLoading(false)
    })
  }, [])

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handlePlexSignIn = async () => {
    if (!form.PLEX_URL.trim()) {
      addToast('Enter the Plex server URL first', 'error')
      return
    }
    try {
      // Save URL to DB before starting OAAuth so poll endpoint can use it
      await client.put('/settings', { settings: { PLEX_URL: form.PLEX_URL } })
      const res = await client.post('/auth/plex/start')
      window.open(res.data.auth_url, '_blank', 'noopener,noreferrer')
      setPlexAuthState('waiting')
      // Start polling every 3 seconds; auto-stop after 5 minutes (100 polls)
      pollCountRef.current = 0
      pollRef.current = setInterval(async () => {
        pollCountRef.current += 1
        if (pollCountRef.current > 100) {
          stopPolling()
          setPlexAuthState('disconnected')
          addToast('Sign-in timed out after 5 minutes. Please try again.', 'error')
          return
        }
        try {
          const r = await client.get('/auth/plex/poll')
          if (r.data.authenticated) {
            stopPolling()
            setPlexAuthState('connected')
            setServerName(r.data.server_name || '')
            setMaskedToken(r.data.masked_token || '')
            addToast(`Connected to ${r.data.server_name || 'Plex'}`, 'success')
          } else if (r.data.expired) {
            stopPolling()
            setPlexAuthState('disconnected')
            addToast('The sign-in window expired. Please try again.', 'error')
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000)
    } catch (e) {
      addToast('Failed to start Plex sign-in: ' + (e?.response?.data?.detail ?? e.message), 'error')
    }
  }

  const handleDisconnect = async () => {
    try {
      await client.post('/auth/plex/disconnect')
      setPlexAuthState('disconnected')
      setServerName('')
      setMaskedToken('')
    } catch (e) {
      addToast('Disconnect failed: ' + (e?.response?.data?.detail ?? e.message), 'error')
    }
  }

  const handleSave = async () => {
    setSaveStatus('saving')
    const payload = {
      PLEX_URL:            form.PLEX_URL,
      COLLECTION_INTERVAL: form.COLLECTION_INTERVAL,
      RETENTION_MONTHS:    form.RETENTION_MONTHS,
    }
    try {
      const res = await client.put('/settings', { settings: payload })
      const d = res.data
      if (d.plex_reconnected && d.plex_connection_ok === false) {
        setSaveStatus('plex_warn')
        addToast('Settings saved — Plex connection test failed', 'info')
      } else {
        setSaveStatus('ok')
        addToast('Settings saved', 'success')
      }
      setTimeout(() => setSaveStatus(null), 4000)
    } catch (e) {
      setSaveStatus({ error: e?.response?.data?.detail ?? e.message })
      addToast('Save failed: ' + (e?.response?.data?.detail ?? e.message), 'error')
    }
  }

  const handleCollect = async () => {
    setCollectStatus('collecting')
    try {
      const res = await client.post('/collect')
      setCollectStatus(res.data)
      addToast(
        `Collection done — ${res.data.libraries_snapshotted ?? 0} librar${res.data.libraries_snapshotted !== 1 ? 'ies' : 'y'} snapshotted`,
        'success',
      )
      setTimeout(() => setCollectStatus(null), 6000)
    } catch (e) {
      setCollectStatus({ error: e?.response?.data?.detail ?? e.message })
      addToast('Collection failed: ' + (e?.response?.data?.detail ?? e.message), 'error')
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
            disabled={plexAuthState === 'waiting'}
          />
        </Field>

        {/* Disconnected — sign-in button */}
        {plexAuthState === 'disconnected' && (
          <div className="flex items-center gap-3">
            <button
              onClick={handlePlexSignIn}
              className="px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors flex items-center gap-2"
              style={{ background: T.accent, color: '#000' }}>
              Sign in with Plex
            </button>
          </div>
        )}

        {/* Waiting — spinner + cancel */}
        {plexAuthState === 'waiting' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm" style={{ color: T.textMuted }}>
              <span className="inline-block animate-spin">&#8635;</span>
              Waiting for Plex authorisation — complete sign-in in the tab that opened
            </div>
            <button
              onClick={() => { stopPolling(); setPlexAuthState('disconnected') }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
              style={{ background: T.border, color: T.textPrimary }}>
              Cancel
            </button>
          </div>
        )}

        {/* Connected — status + disconnect */}
        {plexAuthState === 'connected' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#22c55e' }}>
              <span>&#9679;</span>
              Connected{serverName ? ` to ${serverName}` : ''}
            </div>
            {maskedToken && (
              <p className="text-xs font-mono" style={{ color: T.textMuted }}>
                Token: {maskedToken}
              </p>
            )}
            <button
              onClick={handleDisconnect}
              className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
              style={{ background: T.border, color: '#f87171', border: '1px solid #ef444450' }}>
              Disconnect
            </button>
          </div>
        )}
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
