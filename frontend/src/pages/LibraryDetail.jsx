import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import client from '../hooks/useApi'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend)

// ── Theme ──────────────────────────────────────────────────────────────────────
const T = {
  bg:          '#0d0d0f',
  card:        '#111114',
  border:      '#1e1e24',
  accent:      '#e5a00d',
  textPrimary: '#f0ede4',
  textMuted:   '#6b6960',
}

const TYPE_COLOR = {
  movie:  '#e5a00d',
  show:   '#3b82f6',
  artist: '#a855f7',
  music:  '#a855f7',
}

const RANGES = ['1m', '3m', '6m', '1y', 'max']
const CHART_TOOLTIP = {
  backgroundColor: T.card,
  borderColor:     T.border,
  borderWidth:     1,
  titleColor:      T.textMuted,
  bodyColor:       T.textPrimary,
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmtDate   = iso => iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
  : ''
const fmtTB     = b  => b != null ? (b / 1e12).toFixed(3) : '—'
const fmtGB     = b  => b != null ? (b / 1e9).toFixed(1)  : '—'
const fmtMB     = b  => b != null ? (b / 1e6).toFixed(0)  : '—'

function typeLabel(type) {
  return { movie: 'Movies', show: 'TV Shows', artist: 'Music', music: 'Music' }[type] ?? type
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function Sk({ className = '' }) {
  return <div className={`animate-pulse rounded bg-[#1e1e24] ${className}`} />
}

function SkeletonDetail() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="space-y-2 flex-1">
          <Sk className="h-7 w-48" />
          <Sk className="h-4 w-32" />
        </div>
        <Sk className="h-10 w-28 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[0, 1].map(i => (
          <div key={i} className="rounded-xl p-6 space-y-3"
            style={{ background: T.card, border: `1px solid ${T.border}` }}>
            <Sk className="h-4 w-32" />
            <Sk className="h-44" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="rounded-xl p-5 space-y-2"
            style={{ background: T.card, border: `1px solid ${T.border}` }}>
            <Sk className="h-3 w-24" />
            <Sk className="h-8 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── RangeTabs ─────────────────────────────────────────────────────────────────
function RangeTabs({ range, onChange }) {
  return (
    <div className="flex gap-1.5">
      {RANGES.map(r => (
        <button key={r} onClick={() => onChange(r)}
          className="px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer"
          style={r === range
            ? { background: T.accent, color: '#000' }
            : { background: 'transparent', color: T.textMuted, border: `1px solid ${T.border}` }
          }>
          {r.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-xl p-5 flex flex-col gap-1"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <span className="text-xs font-medium uppercase tracking-wider"
        style={{ color: T.textMuted }}>{label}</span>
      <span className="text-2xl font-bold tabular-nums mt-0.5"
        style={{ color: T.textPrimary }}>{value}</span>
      {sub && <span className="text-xs" style={{ color: T.textMuted }}>{sub}</span>}
    </div>
  )
}

// ── LineCard ──────────────────────────────────────────────────────────────────
function LineCard({ title, color, labels, values, yFmt, loading }) {
  const data = {
    labels,
    datasets: [{
      label: title,
      data: values,
      borderColor: color,
      backgroundColor: color + '18',
      fill: true,
      tension: 0.35,
      pointRadius: labels.length > 60 ? 0 : 2,
      pointHoverRadius: 4,
      spanGaps: false,
    }],
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...CHART_TOOLTIP,
        callbacks: { label: ctx => ` ${ctx.parsed.y != null ? yFmt(ctx.parsed.y) : '—'}` },
      },
    },
    scales: {
      x: {
        ticks: { color: T.textMuted, maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } },
        grid:  { color: T.border + '80' },
      },
      y: {
        beginAtZero: false,
        ticks: { color: T.textMuted, font: { size: 11 }, callback: yFmt },
        grid:  { color: T.border + '80' },
      },
    },
  }

  return (
    <div className="rounded-xl p-6"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <h3 className="text-sm font-semibold mb-4" style={{ color: T.textPrimary }}>{title}</h3>
      <div style={{ height: 200, opacity: loading ? 0.4 : 1, transition: 'opacity 0.2s' }}>
        {labels.length > 1
          ? <Line data={data} options={options} />
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

// ── LibraryDetail ─────────────────────────────────────────────────────────────
export default function LibraryDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const numId = parseInt(id, 10)

  const [libInfo,   setLibInfo]   = useState(null)
  const [snapshots, setSnapshots] = useState([])
  const [growth,    setGrowth]    = useState(null)
  const [range,     setRange]     = useState('6m')
  const [loading,   setLoading]   = useState(true)
  const [snapLoading, setSnapLoading] = useState(false)
  const [error,     setError]     = useState(null)
  const [retryKey,  setRetryKey]  = useState(0)

  // Fetch library info from the summary libraries list
  useEffect(() => {
    if (!numId) return
    setLoading(true)
    Promise.all([
      client.get('/libraries').then(r => r.data),
      client.get(`/libraries/${numId}/growth`).then(r => r.data).catch(() => null),
    ])
      .then(([libs, g]) => {
        const found = libs.find(l => l.id === numId)
        if (!found) { setError('Library not found.'); return }
        setLibInfo(found)
        setGrowth(g)
      })
      .catch(() => setError('Failed to load library.'))
      .finally(() => setLoading(false))
  }, [numId, retryKey])

  // Fetch snapshots whenever range changes
  const fetchSnaps = useCallback(async (r) => {
    if (!numId) return
    setSnapLoading(true)
    try {
      const res = await client.get(`/libraries/${numId}/snapshots?range=${r}`)
      setSnapshots(res.data)
    } catch {
      setSnapshots([])
    } finally {
      setSnapLoading(false)
    }
  }, [numId])

  useEffect(() => { fetchSnaps(range) }, [range, fetchSnaps])

  const handleRangeChange = r => { setRange(r); fetchSnaps(r) }

  // ── Derived ────────────────────────────────────────────────────────────────
  if (loading) return <SkeletonDetail />
  if (error) return (
    <div className="rounded-xl p-6 space-y-3"
      style={{ background: '#ef444415', border: '1px solid #ef4444' }}>
      <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>
      <button
        onClick={() => { setError(null); setLoading(true); setRetryKey(k => k + 1) }}
        className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
        style={{ background: '#ef444430', color: '#f87171' }}>
        Retry
      </button>
    </div>
  )
  if (!libInfo) return null

  const color        = TYPE_COLOR[libInfo.type] || T.accent
  const latest       = snapshots.length ? snapshots[snapshots.length - 1] : null
  const labels       = snapshots.map(s => fmtDate(s.captured_at))
  const itemValues   = snapshots.map(s => s.item_count)
  const sizeValuesGB = snapshots.map(s => s.total_size_bytes / 1e9)

  const latestCount  = latest?.item_count      ?? libInfo.item_count      ?? 0
  const latestBytes  = latest?.total_size_bytes ?? libInfo.total_size_bytes ?? 0
  const avgFileBytes = latestCount > 0 ? latestBytes / latestCount : null

  const monthlyGB    = growth?.avg_monthly_growth_bytes != null
    ? `+${fmtGB(growth.avg_monthly_growth_bytes)} GB/mo` : '—'
  const monthlyItems = growth?.avg_monthly_item_growth != null
    ? `+${Math.round(growth.avg_monthly_item_growth)} items/mo` : '—'

  return (
    <div className="space-y-6" style={{ color: T.textPrimary }}>

      {/* 1 — Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-2xl font-bold">{libInfo.name}</h2>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ background: color + '20', color }}>
              {typeLabel(libInfo.type)}
            </span>
          </div>
          <p className="text-sm" style={{ color: T.textMuted }}>
            {latestCount.toLocaleString()} items &nbsp;·&nbsp; {fmtTB(latestBytes)} TB
          </p>
        </div>
        <RangeTabs range={range} onChange={handleRangeChange} />
      </div>

      {/* 2 — Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LineCard
          title="Item Count"
          color={color}
          labels={labels}
          values={itemValues}
          yFmt={v => Number(v).toLocaleString()}
          loading={snapLoading}
        />
        <LineCard
          title="Storage Size"
          color={color}
          labels={labels}
          values={sizeValuesGB}
          yFmt={v => `${Number(v).toFixed(1)} GB`}
          loading={snapLoading}
        />
      </div>

      {/* 3 — Growth stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Avg Monthly Growth"
          value={growth?.avg_monthly_growth_bytes != null ? `${fmtGB(growth.avg_monthly_growth_bytes)} GB` : '—'}
          sub={growth ? monthlyGB : 'Not enough data'}
        />
        <StatCard
          label="Avg New Items / Month"
          value={growth?.avg_monthly_item_growth != null ? `+${Math.round(growth.avg_monthly_item_growth)}` : '—'}
          sub={monthlyItems}
        />
        <StatCard
          label="Avg File Size"
          value={avgFileBytes != null ? `${fmtMB(avgFileBytes)} MB` : '—'}
          sub="total size ÷ item count"
        />
      </div>

      {/* 4 — Largest items placeholder */}
      <div className="rounded-xl p-6"
        style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>Largest Items</h3>
          <span className="text-xs px-2 py-0.5 rounded"
            style={{ background: T.border, color: T.textMuted }}>Coming in v1.1</span>
        </div>
        <p className="text-sm" style={{ color: T.textMuted }}>
          Plex API integration for item-level data coming in v1.1. This section will list the
          largest individual files in this library so you can identify oversized content.
        </p>
      </div>

    </div>
  )
}

