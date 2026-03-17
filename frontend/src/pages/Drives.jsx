import { useState, useEffect, useCallback } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import client, { useGet } from '../hooks/useApi'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

// ── Theme ──────────────────────────────────────────────────────────────────────
const T = {
  card:        '#111114',
  border:      '#1e1e24',
  accent:      '#e5a00d',
  textPrimary: '#f0ede4',
  textMuted:   '#6b6960',
}

const RANGES       = ['1m', '3m', '6m', '1y', 'max']
const MOUNT_COLORS = ['#e5a00d', '#3b82f6', '#a855f7', '#22c55e', '#f97316', '#ec4899']

const CHART_TOOLTIP = {
  backgroundColor: T.card,
  borderColor:     T.border,
  borderWidth:     1,
  titleColor:      T.textMuted,
  bodyColor:       T.textPrimary,
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtTimestamp(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fillBarColor(pct) {
  if (pct >= 85) return '#ef4444'
  if (pct >= 70) return '#f59e0b'
  return '#22c55e'
}

// ── Skeleton ───────────────────────────────────────────────────────────────────
function Sk({ className = '' }) {
  return <div className={`animate-pulse rounded bg-[#1e1e24] ${className}`} />
}

function SkeletonDrives() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="rounded-xl p-5 space-y-4"
            style={{ background: T.card, border: `1px solid ${T.border}` }}>
            <Sk className="h-4 w-48" />
            <div className="grid grid-cols-3 gap-3">
              {[...Array(3)].map((_, j) => <Sk key={j} className="h-12" />)}
            </div>
            <Sk className="h-2 w-full rounded-full" />
            <Sk className="h-3 w-40" />
          </div>
        ))}
      </div>
      <div className="rounded-xl p-6 space-y-4"
        style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <Sk className="h-4 w-40" />
        <Sk className="h-56" />
      </div>
      <Sk className="h-16 rounded-xl" />
    </div>
  )
}

// ── MountCard ──────────────────────────────────────────────────────────────────
function MountCard({ mount }) {
  const pct   = mount.percent_used
  const color = fillBarColor(pct)

  return (
    <div className="rounded-xl p-5 space-y-4"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold truncate" style={{ color: T.textPrimary }}>
          {mount.mount_point}
        </span>
        <span className="text-sm font-bold tabular-nums flex-shrink-0" style={{ color }}>
          {pct.toFixed(1)}%
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: 'Total', value: fmtBytes(mount.total_bytes) },
          { label: 'Used',  value: fmtBytes(mount.used_bytes)  },
          { label: 'Free',  value: fmtBytes(mount.free_bytes)  },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg px-2 py-2.5 space-y-0.5"
            style={{ background: '#0d0d10' }}>
            <div className="text-xs font-medium" style={{ color: T.textMuted }}>{label}</div>
            <div className="text-sm font-bold tabular-nums" style={{ color: T.textPrimary }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Fill bar */}
      <div className="h-2 rounded-full overflow-hidden" style={{ background: T.border }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, background: color }}
        />
      </div>

      {/* Timestamp */}
      <p className="text-xs" style={{ color: T.textMuted }}>
        Updated {fmtTimestamp(mount.captured_at)}
      </p>
    </div>
  )
}

// ── FillChart ──────────────────────────────────────────────────────────────────
function FillChart({ snapshots, range, onRangeChange, loading }) {
  const mounts = Object.keys(snapshots)

  const allTs = [...new Set(
    mounts.flatMap(m => (snapshots[m] || []).map(p => p.captured_at))
  )].sort()

  const labels   = allTs.map(fmtDate)
  const datasets = mounts.map((mount, idx) => {
    const pts   = snapshots[mount] || []
    const map   = Object.fromEntries(
      pts.map(p => [p.captured_at, p.total_bytes > 0 ? (p.used_bytes / p.total_bytes) * 100 : 0])
    )
    const color = MOUNT_COLORS[idx % MOUNT_COLORS.length]
    return {
      label:            mount,
      data:             allTs.map(ts => map[ts] ?? null),
      borderColor:      color,
      backgroundColor:  'transparent',
      pointRadius:      allTs.length > 60 ? 0 : 2,
      pointHoverRadius: 4,
      fill:             false,
      tension:          0.3,
      spanGaps:         false,
    }
  })

  const options = {
    responsive:          true,
    maintainAspectRatio: false,
    interaction:         { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels:   { color: T.textMuted, boxWidth: 10, padding: 16, font: { size: 11 } },
      },
      tooltip: {
        ...CHART_TOOLTIP,
        callbacks: {
          label: ctx => ctx.parsed.y != null
            ? ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`
            : null,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: T.textMuted, maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } },
        grid:  { color: T.border + '80' },
      },
      y: {
        min:   0,
        max:   100,
        ticks: {
          color:    T.textMuted,
          font:     { size: 11 },
          callback: v => `${v}%`,
        },
        grid: { color: T.border + '80' },
      },
    },
  }

  return (
    <div className="rounded-xl p-6" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>Fill % Over Time</h3>
        <div className="flex gap-1.5">
          {RANGES.map(r => (
            <button key={r} onClick={() => onRangeChange(r)}
              className="px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer"
              style={r === range
                ? { background: T.accent, color: '#000' }
                : { background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}` }
              }>
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div style={{ height: 260, opacity: loading ? 0.45 : 1, transition: 'opacity 0.2s' }}>
        {allTs.length > 1
          ? <Line data={{ labels, datasets }} options={options} />
          : (
            <div className="h-full flex items-center justify-center text-sm"
              style={{ color: T.textMuted }}>
              Not enough data to draw a chart yet.
            </div>
          )
        }
      </div>
    </div>
  )
}

// ── InfoBox ────────────────────────────────────────────────────────────────────
function InfoBox({ intervalLabel }) {
  return (
    <div className="rounded-xl px-5 py-4 flex gap-3 items-start"
      style={{ background: '#0a0e15', border: `1px solid ${T.border}` }}>
      <span style={{ color: T.textMuted, fontSize: 15, lineHeight: '1.5rem', flexShrink: 0 }}>ℹ</span>
      <div>
        <p className="text-xs font-semibold mb-1" style={{ color: T.textPrimary }}>
          How is storage tracked?
        </p>
        <p className="text-xs leading-relaxed" style={{ color: T.textMuted }}>
          PlexPulse reads{' '}
          <code className="font-mono px-1 rounded" style={{ background: T.border }}>/proc/mounts</code>
          {' '}and uses Python's{' '}
          <code className="font-mono px-1 rounded" style={{ background: T.border }}>shutil.disk_usage()</code>
          {' '}to measure each mount point every{' '}
          <span style={{ color: T.textPrimary }}>{intervalLabel}</span>.
        </p>
      </div>
    </div>
  )
}

// ── Drives (main) ──────────────────────────────────────────────────────────────
export default function Drives() {
  const { data: mounts, loading, error, refetch } = useGet('/disk')
  const [range,            setRange]            = useState('6m')
  const [snapshots,        setSnapshots]        = useState({})
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [intervalLabel,    setIntervalLabel]    = useState('a configurable interval')

  // Try to read COLLECTION_INTERVAL from settings
  useEffect(() => {
    client.get('/settings')
      .then(r => {
        const raw = r.data?.settings?.COLLECTION_INTERVAL
        if (raw) setIntervalLabel(raw)
      })
      .catch(() => {})
  }, [])

  // Fetch snapshots for all mounts when mount-list or range changes
  const fetchSnapshots = useCallback(async (mountList, r) => {
    if (!mountList?.length) return
    setSnapshotsLoading(true)
    const pairs = await Promise.all(
      mountList.map(m =>
        client
          .get(`/disk/snapshots?mount=${encodeURIComponent(m.mount_point)}&range=${r}`)
          .then(res => [m.mount_point, res.data])
          .catch(() => [m.mount_point, []])
      )
    )
    setSnapshots(Object.fromEntries(pairs))
    setSnapshotsLoading(false)
  }, [])

  useEffect(() => {
    if (mounts?.length) fetchSnapshots(mounts, range)
  }, [mounts, range, fetchSnapshots])

  if (loading) return <SkeletonDrives />
  if (error) return (
    <div className="rounded-xl p-6 space-y-3"
      style={{ background: '#ef444415', border: '1px solid #ef4444' }}>
      <p className="text-sm" style={{ color: '#f87171' }}>Failed to load disk data: {error}</p>
      <button
        onClick={refetch}
        className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
        style={{ background: '#ef444430', color: '#f87171' }}>
        Retry
      </button>
    </div>
  )
  if (!mounts?.length) return (
    <div className="rounded-xl p-6 text-sm"
      style={{ background: T.card, border: `1px solid ${T.border}`, color: T.textMuted }}>
      No disk mounts recorded yet. Ensure PlexPulse has collected at least one snapshot.
    </div>
  )

  return (
    <div className="space-y-5" style={{ color: T.textPrimary }}>

      {/* 1 — Mount cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {mounts.map(m => <MountCard key={m.mount_point} mount={m} />)}
      </div>

      {/* 2 — Fill % over time */}
      <FillChart
        snapshots={snapshots}
        range={range}
        onRangeChange={setRange}
        loading={snapshotsLoading}
      />

      {/* 3 — Info box */}
      <InfoBox intervalLabel={intervalLabel} />

    </div>
  )
}
