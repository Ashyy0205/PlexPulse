import { useState, useEffect } from 'react'
import client from '../hooks/useApi'

// ── Theme ──────────────────────────────────────────────────────────────────────
const T = {
  card:        '#111114',
  border:      '#1e1e24',
  accent:      '#e5a00d',
  textPrimary: '#f0ede4',
  textMuted:   '#6b6960',
}

const ALERT_TYPE_META = {
  free_space_gb:      { label: 'Free Space drops below', unit: 'GB',    placeholder: '100', hint: 'Alert when free disk space falls below this number of GB' },
  free_space_percent: { label: 'Free Space below',       unit: '%',     placeholder: '15',  hint: 'Alert when free disk space falls below this percentage' },
  runway_days:        { label: 'Storage runway under',   unit: 'days',  placeholder: '30',  hint: 'Alert when projected days of free space remaining drops below this' },
  monthly_growth_gb:  { label: 'Monthly growth exceeds', unit: 'GB/mo', placeholder: '500', hint: 'Alert when estimated monthly data growth exceeds this amount' },
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtTimestamp(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Skeleton ───────────────────────────────────────────────────────────────────
function Sk({ className = '' }) {
  return <div className={`animate-pulse rounded bg-[#1e1e24] ${className}`} />
}

// ── Toggle ─────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative flex-shrink-0 rounded-full transition-colors focus:outline-none"
      style={{
        width: 36, height: 20,
        background: checked ? '#22c55e' : T.border,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <span
        className="absolute top-0.5 rounded-full transition-transform"
        style={{
          width: 16, height: 16,
          background: '#fff',
          transform: checked ? 'translateX(17px)' : 'translateX(2px)',
        }}
      />
    </button>
  )
}

// ── AlertCard ──────────────────────────────────────────────────────────────────
function AlertCard({ rule, onToggle, onDelete, onTest }) {
  const meta = ALERT_TYPE_META[rule.alert_type] || { label: rule.alert_type, unit: rule.threshold_unit }
  const [toggleLoading, setToggleLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [testLoading,   setTestLoading]   = useState(false)
  const [testResult,    setTestResult]    = useState(null)

  const handleToggle = async (val) => {
    setToggleLoading(true)
    await onToggle(rule.id, val)
    setToggleLoading(false)
  }

  const handleDelete = async () => {
    setDeleteLoading(true)
    await onDelete(rule.id)
    setDeleteLoading(false)
  }

  const handleTest = async () => {
    setTestLoading(true)
    setTestResult(null)
    const result = await onTest(rule.id)
    setTestResult(result)
    setTestLoading(false)
  }

  return (
    <div className="rounded-xl p-5 space-y-4"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>

      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: T.textPrimary }}>
              {meta.label}
            </span>
            <span className="text-sm font-bold tabular-nums" style={{ color: T.accent }}>
              {rule.threshold_value} {rule.threshold_unit}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-xs capitalize px-2 py-0.5 rounded-full"
              style={{ background: '#1e1e24', color: T.textMuted }}>
              {rule.channel}
            </span>
            <span className="text-xs truncate" style={{ color: T.textMuted, maxWidth: 220 }}>
              {rule.destination}
            </span>
          </div>
        </div>
        <Toggle
          checked={rule.enabled}
          onChange={handleToggle}
          disabled={toggleLoading}
        />
      </div>

      {/* Last triggered */}
      {rule.last_triggered_at && (
        <p className="text-xs" style={{ color: T.textMuted }}>
          Last triggered: {fmtTimestamp(rule.last_triggered_at)}
        </p>
      )}

      {/* Test result */}
      {testResult && (
        <div className="rounded-lg px-3 py-2 text-xs"
          style={{
            background: testResult.success ? '#22c55e18' : '#ef444418',
            border: `1px solid ${testResult.success ? '#22c55e40' : '#ef444440'}`,
            color: testResult.success ? '#86efac' : '#f87171',
          }}>
          {testResult.success ? '✓' : '✕'} {testResult.detail}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleTest}
          disabled={testLoading}
          className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
          style={{ background: T.border, color: T.textPrimary }}>
          {testLoading ? 'Testing…' : 'Test'}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleteLoading}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
          style={{ background: '#ef444414', color: '#f87171', border: '1px solid #ef444430' }}>
          {deleteLoading ? '…' : 'Delete'}
        </button>
      </div>
    </div>
  )
}

// ── AddAlertForm (inline) ──────────────────────────────────────────────────────
const EMPTY_FORM = { alert_type: 'free_space_gb', threshold_value: '', channel: 'webhook', destination: '' }

function AddAlertForm({ onSave, onCancel }) {
  const [form,   setForm]   = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  const meta = ALERT_TYPE_META[form.alert_type]
  const set  = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    if (!form.threshold_value || !form.destination) {
      setError('Threshold value and destination are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        alert_type:      form.alert_type,
        threshold_value: parseFloat(form.threshold_value),
        threshold_unit:  meta.unit,
        channel:         form.channel,
        destination:     form.destination,
      })
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message)
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl p-5 space-y-4"
      style={{ background: '#0a0e15', border: `1px solid ${T.accent}50` }}>
      <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>New Alert Rule</h3>

      {/* Type */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: T.textMuted }}>Alert type</label>
        <select
          value={form.alert_type}
          onChange={e => set('alert_type', e.target.value)}
          className="w-full px-3 py-2 rounded-lg text-sm outline-none cursor-pointer"
          style={{ background: T.border, color: T.textPrimary, border: 'none' }}>
          {Object.entries(ALERT_TYPE_META).map(([val, m]) => (
            <option key={val} value={val}>{m.label}</option>
          ))}
        </select>
        <p className="text-xs" style={{ color: T.textMuted }}>{meta.hint}</p>
      </div>

      {/* Threshold */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: T.textMuted }}>Threshold</label>
        <div className="flex items-center gap-2">
          <input
            type="number" min={0}
            placeholder={meta.placeholder}
            value={form.threshold_value}
            onChange={e => set('threshold_value', e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: T.border, color: T.textPrimary, border: 'none' }}
          />
          <span className="text-sm font-medium w-14 text-right flex-shrink-0" style={{ color: T.textMuted }}>
            {meta.unit}
          </span>
        </div>
      </div>

      {/* Channel */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: T.textMuted }}>Channel</label>
        <div className="flex gap-2">
          {['webhook', 'email'].map(ch => (
            <button
              key={ch}
              onClick={() => set('channel', ch)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
              style={form.channel === ch
                ? { background: T.accent, color: '#000' }
                : { background: T.border, color: T.textMuted }
              }>
              {ch === 'webhook' ? 'Webhook' : 'Email'}
            </button>
          ))}
        </div>
      </div>

      {/* Destination */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: T.textMuted }}>
          {form.channel === 'webhook' ? 'Webhook URL' : 'Email Address'}
        </label>
        <input
          type={form.channel === 'email' ? 'email' : 'url'}
          placeholder={form.channel === 'webhook' ? 'https://hooks.example.com/...' : 'you@example.com'}
          value={form.destination}
          onChange={e => set('destination', e.target.value)}
          className="w-full px-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: T.border, color: T.textPrimary, border: 'none' }}
        />
      </div>

      {error && (
        <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
          style={{ background: T.accent, color: '#000' }}>
          {saving ? 'Saving…' : 'Save Rule'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer"
          style={{ background: T.border, color: T.textMuted }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Alert History ──────────────────────────────────────────────────────────────
function HistoryList({ entries }) {
  if (!entries.length) {
    return (
      <p className="text-sm" style={{ color: T.textMuted }}>
        No alerts have been triggered yet.
      </p>
    )
  }
  return (
    <div>
      {entries.map(e => (
        <div key={e.id} className="flex items-start gap-3 py-3"
          style={{ borderTop: `1px solid ${T.border}` }}>
          <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
            style={{ background: '#f59e0b' }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm leading-snug" style={{ color: T.textPrimary }}>{e.message}</p>
            <p className="text-xs mt-0.5" style={{ color: T.textMuted }}>
              {fmtTimestamp(e.triggered_at)}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Alerts page ────────────────────────────────────────────────────────────────
export default function Alerts() {
  const [rules,       setRules]       = useState([])
  const [history,     setHistory]     = useState([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)

  useEffect(() => {
    Promise.all([
      client.get('/alerts').then(r => r.data).catch(() => []),
      client.get('/alerts/history').then(r => r.data).catch(() => []),
    ]).then(([alertData, histData]) => {
      setRules(alertData)
      setHistory(histData.slice(0, 20))
      setLoading(false)
    }).catch(e => {
      setError(e?.message ?? 'Failed to load alerts')
      setLoading(false)
    })
  }, [])

  const handleToggle = async (id, enabled) => {
    try {
      const res = await client.put(`/alerts/${id}`, { enabled })
      setRules(prev => prev.map(r => r.id === id ? { ...r, ...res.data } : r))
    } catch { /* no-op */ }
  }

  const handleDelete = async (id) => {
    try {
      await client.delete(`/alerts/${id}`)
      setRules(prev => prev.filter(r => r.id !== id))
    } catch { /* no-op */ }
  }

  const handleTest = async (id) => {
    try {
      const res = await client.post(`/alerts/test/${id}`)
      return res.data
    } catch (e) {
      return { success: false, detail: e?.response?.data?.detail ?? e.message }
    }
  }

  const handleCreate = async (formData) => {
    const res = await client.post('/alerts', formData)
    setRules(prev => [...prev, res.data])
    setShowAddForm(false)
  }

  if (loading) return (
    <div className="space-y-4">
      {[...Array(2)].map((_, i) => (
        <div key={i} className="rounded-xl p-5 space-y-3"
          style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <Sk className="h-4 w-48" /><Sk className="h-3 w-32" />
          <Sk className="h-8 w-full" />
        </div>
      ))}
    </div>
  )

  if (error) return (
    <div className="rounded-xl p-6 text-sm"
      style={{ background: '#ef444415', border: '1px solid #ef4444', color: '#f87171' }}>
      {error}
    </div>
  )

  return (
    <div className="space-y-6" style={{ color: T.textPrimary }}>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: T.textPrimary }}>Alert Rules</h2>
        <button
          onClick={() => setShowAddForm(v => !v)}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
          style={showAddForm
            ? { background: T.border, color: T.textMuted }
            : { background: T.accent, color: '#000' }
          }>
          {showAddForm ? 'Cancel' : '+ Add Alert'}
        </button>
      </div>

      {/* Rules grid */}
      {rules.length === 0 && !showAddForm ? (
        <div className="rounded-xl p-10 text-center"
          style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <p className="text-sm" style={{ color: T.textMuted }}>
            No alert rules configured. Add one to get notified when thresholds are crossed.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {rules.map(rule => (
            <AlertCard
              key={rule.id}
              rule={rule}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onTest={handleTest}
            />
          ))}
        </div>
      )}

      {/* Inline add form */}
      {showAddForm && (
        <AddAlertForm
          onSave={handleCreate}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* History */}
      <div className="rounded-xl p-6" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <h3 className="text-sm font-semibold mb-1" style={{ color: T.textPrimary }}>
          Alert History
          <span className="text-xs font-normal ml-2" style={{ color: T.textMuted }}>(last 20)</span>
        </h3>
        <HistoryList entries={history} />
      </div>

    </div>
  )
}
