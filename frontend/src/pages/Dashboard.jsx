import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line, Doughnut } from 'react-chartjs-2'
import client, { useGet } from '../hooks/useApi'
import { useToast } from '../components/Toast'

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  ArcElement, Filler, Tooltip, Legend,
)

// ── Theme ───────────────────────────────────────────────────────────────────
const T = {
  card:        '#111114',
  border:      '#1e1e24',
  accent:      '#e5a00d',
  textPrimary: '#f0ede4',
  textMuted:   '#6b6960',
}

const LIB_COLORS = {
  movie:  '#e5a00d',
  show:   '#3b82f6',
  artist: '#a855f7',
  music:  '#a855f7',
}

const RANGES = ['1m', '3m', '6m', '1y', 'max']

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmtTB    = b  => b != null ? (b / 1e12).toFixed(2) : '—'
const fmtDate  = iso => iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  : ''

function daysColor(days) {
  if (days == null) return T.textPrimary
  if (days > 90)   return '#22c55e'
  if (days > 30)   return '#f59e0b'
  return '#ef4444'
}

const CHART_TOOLTIP = {
  backgroundColor: '#111114',
  borderColor:     '#1e1e24',
  borderWidth:     1,
  titleColor:      '#6b6960',
  bodyColor:       '#f0ede4',
}

// Smart byte formatter — picks appropriate unit
function fmtBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

// ── Skeleton ─────────────────────────────────────────────────────────────────
function Sk({ className = '' }) {
  return <div className={`animate-pulse rounded bg-[#1e1e24] ${className}`} />
}

function SkeletonDashboard() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl p-5 space-y-3"
            style={{ background: T.card, border: `1px solid ${T.border}` }}>
            <Sk className="h-3 w-20" />
            <Sk className="h-9 w-28" />
            <Sk className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-xl p-5 space-y-4"
            style={{ background: T.card, border: `1px solid ${T.border}` }}>
            <Sk className="h-3 w-28" />
            <Sk className="h-32 w-32 rounded-full mx-auto" />
            <Sk className="h-5 w-16 mx-auto" />
          </div>
        ))}
      </div>
      <div className="rounded-xl p-6 space-y-4"
        style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <Sk className="h-4 w-40" />
        <Sk className="h-56" />
      </div>
      <div className="rounded-xl p-6 space-y-3"
        style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <Sk className="h-4 w-32" />
        {[...Array(3)].map((_, i) => <Sk key={i} className="h-8" />)}
      </div>
    </div>
  )
}

// ── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({ title, value, sub, valueColor }) {
  return (
    <div className="rounded-xl p-5 flex flex-col gap-1"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <span className="text-xs font-medium uppercase tracking-wider"
        style={{ color: T.textMuted }}>{title}</span>
      <span className="text-3xl font-bold mt-1 tabular-nums"
        style={{ color: valueColor || T.textPrimary }}>{value}</span>
      <span className="text-xs" style={{ color: T.textMuted }}>{sub}</span>
    </div>
  )
}

// ── LibraryDonut ─────────────────────────────────────────────────────────────
function LibraryDonut({ library, totalDiskUsed, growth }) {
  const color    = LIB_COLORS[library.type] || T.accent
  const libBytes = library.total_size_bytes || 0
  const other    = Math.max(0, (totalDiskUsed || 0) - libBytes)

  const donutData = {
    datasets: [{
      data: [libBytes || 1, other || 1],
      backgroundColor: [color, T.border],
      borderWidth: 0,
    }],
  }
  const donutOpts = {
    cutout: '72%',
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    animation: { duration: 500 },
  }

  const monthly = growth?.avg_monthly_item_growth != null
    ? `+${Math.round(growth.avg_monthly_item_growth)} items/mo`
    : 'Trend pending'

  return (
    <div className="rounded-xl p-5"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-2 mb-4">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="text-sm font-medium" style={{ color: T.textPrimary }}>{library.name}</span>
        <span className="ml-auto text-xs capitalize" style={{ color: T.textMuted }}>{library.type}</span>
      </div>

      <div className="relative mx-auto" style={{ width: 120, height: 120 }}>
        <Doughnut data={donutData} options={donutOpts} />
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-sm font-bold tabular-nums" style={{ color: T.textPrimary }}>
            {fmtBytes(libBytes)}
          </span>
        </div>
      </div>

      <div className="mt-4 text-center space-y-0.5">
        <div className="text-2xl font-bold tabular-nums" style={{ color: T.textPrimary }}>
          {(library.item_count || 0).toLocaleString()}
        </div>
        <div className="text-xs" style={{ color: T.textMuted }}>{monthly}</div>
      </div>
    </div>
  )
}

// ── StorageChart ─────────────────────────────────────────────────────────────
function StorageChart({ libraries, snapshots, range, onRangeChange, loading }) {
  const allTs = [...new Set(
    libraries.flatMap(lib => (snapshots[lib.id] || []).map(p => p.captured_at))
  )].sort()

  const labels   = allTs.map(fmtDate)
  const datasets = libraries.map(lib => {
    const pts  = snapshots[lib.id] || []
    const map  = Object.fromEntries(pts.map(p => [p.captured_at, p.total_size_bytes / 1e12]))
    const color = LIB_COLORS[lib.type] || T.accent
    return {
      label: lib.name,
      data: allTs.map(ts => map[ts] ?? null),
      borderColor: color,
      backgroundColor: color + '18',
      pointRadius: allTs.length > 60 ? 0 : 2,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.35,
      spanGaps: false,
    }
  })

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { color: T.textMuted, boxWidth: 10, padding: 16, font: { size: 11 } } },
      tooltip: { ...CHART_TOOLTIP, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)} TB` } },
    },
    scales: {
      x: { ticks: { color: T.textMuted, maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } }, grid: { color: T.border + '80' } },
      y: { beginAtZero: true, ticks: { color: T.textMuted, font: { size: 11 }, callback: v => `${Number(v).toFixed(1)} TB` }, grid: { color: T.border + '80' } },
    },
  }

  return (
    <div className="rounded-xl p-6"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>Storage Over Time</h3>
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
      <div style={{ height: 220, opacity: loading ? 0.45 : 1, transition: 'opacity 0.2s' }}>
        {allTs.length > 1
          ? <Line data={{ labels, datasets }} options={options} />
          : <Empty>Not enough data to draw a chart yet.</Empty>
        }
      </div>
    </div>
  )
}

// ── GrowthTable ──────────────────────────────────────────────────────────────
function GrowthTable({ libraries, growthData }) {
  const rows = libraries
    .map(lib => ({
      id:           lib.id,
      name:         lib.name,
      type:         lib.type,
      gbPerMonth:   growthData[lib.id]?.avg_monthly_growth_bytes != null
        ? growthData[lib.id].avg_monthly_growth_bytes / 1e9 : null,
      itemsPerMonth: growthData[lib.id]?.avg_monthly_item_growth ?? null,
    }))
    .filter(r => r.gbPerMonth != null)

  const maxGb  = Math.max(...rows.map(r => Math.abs(r.gbPerMonth)), 0.1)
  const total  = rows.reduce((s, r) => s + (r.gbPerMonth || 0), 0)

  return (
    <div className="rounded-xl p-6"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <h3 className="text-sm font-semibold mb-4" style={{ color: T.textPrimary }}>Monthly Growth</h3>
      {rows.length === 0
        ? <p className="text-sm" style={{ color: T.textMuted }}>Not enough history yet — check back after a few collections.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {['Library', 'GB / month', 'Items / month', ''].map((h, i) => (
                    <th key={i}
                      className={`pb-3 text-xs font-medium uppercase tracking-wider ${i > 0 ? 'text-right' : 'text-left'} ${i === 3 ? 'w-32' : ''}`}
                      style={{ color: T.textMuted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: LIB_COLORS[row.type] || T.accent }} />
                        <span style={{ color: T.textPrimary }}>{row.name}</span>
                      </div>
                    </td>
                    <td className="py-3 text-right font-mono" style={{ color: T.textPrimary }}>
                      +{row.gbPerMonth.toFixed(1)}
                    </td>
                    <td className="py-3 text-right" style={{ color: T.textMuted }}>
                      {row.itemsPerMonth != null ? `+${Math.round(row.itemsPerMonth)}` : '—'}
                    </td>
                    <td className="py-3 pl-4">
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: T.border }}>
                        <div className="h-full rounded-full transition-all"
                          style={{
                            width: `${(Math.abs(row.gbPerMonth) / maxGb) * 100}%`,
                            background: LIB_COLORS[row.type] || T.accent,
                          }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${T.accent}50` }}>
                  <td className="pt-3 font-semibold" style={{ color: T.textPrimary }}>Total</td>
                  <td className="pt-3 text-right font-mono font-semibold" style={{ color: T.accent }}>
                    +{total.toFixed(1)} GB
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )
      }
    </div>
  )
}

// ── BurndownChart ────────────────────────────────────────────────────────────
function BurndownChart({ diskSnapshots, forecast, daysRemaining }) {
  const histSorted = [...(diskSnapshots || [])]
    .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
  const histLabels = histSorted.map(s => fmtDate(s.captured_at))
  const histValues = histSorted.map(s => s.free_bytes / 1e12)

  const fcPts   = forecast?.forecast_points || []
  const fcLow   = forecast?.confidence_low  || []
  const fcHigh  = forecast?.confidence_high || []
  const fcLabels = fcPts.map(p => fmtDate(p.date))

  const allLabels = [
    ...histLabels,
    ...fcLabels.filter(l => !histLabels.includes(l)),
  ]

  function align(srcLabels, srcValues) {
    return allLabels.map(l => {
      const i = srcLabels.indexOf(l)
      return i >= 0 ? srcValues[i] : null
    })
  }

  const datasets = [
    {
      label: 'Free Space',
      data: align(histLabels, histValues),
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34,197,94,0.07)',
      fill: true, tension: 0.35, spanGaps: false,
      pointRadius: histLabels.length > 50 ? 0 : 2, pointHoverRadius: 4,
    },
    {
      label: 'Forecast',
      data: align(fcLabels, fcPts.map(p => p.free_bytes / 1e12)),
      borderColor: T.accent,
      borderDash: [6, 3],
      backgroundColor: 'transparent',
      fill: false, tension: 0.35, spanGaps: false, pointRadius: 0,
    },
    {
      label: 'CI Low',
      data: align(fcLabels, fcLow.map(p => p.free_bytes / 1e12)),
      borderColor: 'transparent',
      backgroundColor: T.accent + '15',
      fill: '+1', tension: 0.35, spanGaps: false, pointRadius: 0,
    },
    {
      label: 'CI High',
      data: align(fcLabels, fcHigh.map(p => p.free_bytes / 1e12)),
      borderColor: 'transparent', backgroundColor: 'transparent',
      fill: false, tension: 0.35, spanGaps: false, pointRadius: 0,
    },
  ]

  const exhaustionLabel = forecast?.projected_exhaustion_date
    ? fmtDate(forecast.projected_exhaustion_date)
    : null
  const showWarning = daysRemaining != null && daysRemaining < 90

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: T.textMuted, boxWidth: 10, padding: 16, font: { size: 11 },
          filter: item => !['CI Low', 'CI High'].includes(item.text),
        },
      },
      tooltip: {
        ...CHART_TOOLTIP,
        filter: item => !['CI Low', 'CI High'].includes(item.dataset.label),
        callbacks: {
          label: ctx => {
            if (['CI Low', 'CI High'].includes(ctx.dataset.label)) return null
            return ctx.parsed.y != null ? ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} TB` : null
          },
        },
      },
    },
    scales: {
      x: { ticks: { color: T.textMuted, maxTicksLimit: 10, maxRotation: 0, font: { size: 11 } }, grid: { color: T.border + '80' } },
      y: { min: 0, ticks: { color: T.textMuted, font: { size: 11 }, callback: v => `${Number(v).toFixed(1)} TB` }, grid: { color: T.border + '80' } },
    },
  }

  return (
    <div className="rounded-xl p-6"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <h3 className="text-sm font-semibold mb-3" style={{ color: T.textPrimary }}>Disk Burndown</h3>

      {showWarning && (
        <div className="mb-4 rounded-lg px-4 py-3 text-sm font-medium"
          style={{ background: '#ef444418', border: '1px solid #ef444460', color: '#f87171' }}>
          ⚠ Only ~{daysRemaining} days of free space remaining
          {exhaustionLabel ? ` — projected full on ${exhaustionLabel}` : ''}.
        </div>
      )}
      {!showWarning && exhaustionLabel && (
        <p className="text-xs mb-3" style={{ color: T.textMuted }}>
          Projected full: <span style={{ color: '#f87171' }}>{exhaustionLabel}</span>
        </p>
      )}

      <div style={{ height: 260 }}>
        {allLabels.length > 1
          ? <Line data={{ labels: allLabels, datasets }} options={options} />
          : <Empty>Not enough data to draw a chart yet.</Empty>
        }
      </div>
    </div>
  )
}

// ── Empty state helper ───────────────────────────────────────────────────────
function Empty({ children }) {
  return (
    <div className="h-full flex items-center justify-center text-sm"
      style={{ color: T.textMuted }}>{children}</div>
  )
}

// ── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { data: summary, loading, error, refetch } = useGet('/summary')
  const { data: settingsData }                      = useGet('/settings')
  const plexConfigured = !!settingsData?.settings?.PLEX_TOKEN
  const [range,            setRange]            = useState('6m')
  const [librarySnapshots, setLibrarySnapshots] = useState({})
  const [diskSnapshots,    setDiskSnapshots]    = useState([])
  const [diskForecast,     setDiskForecast]     = useState(null)
  const [growthData,       setGrowthData]       = useState({})
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const addToast = useToast()
  const [collectingNow, setCollectingNow] = useState(false)

  // Per-library growth stats
  useEffect(() => {
    const libs = summary?.libraries
    if (!libs?.length) return
    Promise.all(
      libs.map(lib =>
        client.get(`/libraries/${lib.id}/growth`)
          .then(r => [lib.id, r.data])
          .catch(() => [lib.id, null])
      )
    ).then(pairs => setGrowthData(Object.fromEntries(pairs)))
  }, [summary?.libraries])

  // Time-series library snapshots (re-fetched on range change)
  const fetchSnapshots = useCallback(async (libs, r) => {
    if (!libs?.length) return
    setSnapshotsLoading(true)
    const pairs = await Promise.all(
      libs.map(lib =>
        client.get(`/libraries/${lib.id}/snapshots?range=${r}`)
          .then(res => [lib.id, res.data])
          .catch(() => [lib.id, []])
      )
    )
    setLibrarySnapshots(Object.fromEntries(pairs))
    setSnapshotsLoading(false)
  }, [])

  useEffect(() => {
    if (summary?.libraries) fetchSnapshots(summary.libraries, range)
  }, [summary?.libraries, range, fetchSnapshots])

  // Disk history + forecast for primary mount
  useEffect(() => {
    const mounts = summary?.disk_mounts
    if (!mounts?.length) return
    const primary = mounts.reduce((a, b) => a.used_bytes > b.used_bytes ? a : b)
    const m = encodeURIComponent(primary.mount_point)
    Promise.all([
      client.get(`/disk/snapshots?mount=${m}&range=max`).then(r => r.data).catch(() => []),
      client.get(`/disk/forecast?mount=${m}&days=730`).then(r => r.data).catch(() => null),
    ]).then(([snaps, fc]) => { setDiskSnapshots(snaps); setDiskForecast(fc) })
  }, [summary?.disk_mounts])

  const handleCollect = async () => {
    setCollectingNow(true)
    try {
      const res = await client.post('/collect')
      addToast(
        `Collection done — ${res.data.libraries_snapshotted ?? 0} librar${res.data.libraries_snapshotted !== 1 ? 'ies' : 'y'} snapshotted`,
        'success',
      )
      refetch()
    } catch (e) {
      addToast('Collection failed: ' + (e?.response?.data?.detail ?? e.message), 'error')
    } finally {
      setCollectingNow(false)
    }
  }

  if (loading) return <SkeletonDashboard />
  if (error) return (
    <div className="rounded-xl p-6 space-y-3"
      style={{ background: '#ef444415', border: '1px solid #ef4444' }}>
      <p className="text-sm" style={{ color: '#f87171' }}>Failed to load dashboard: {error}</p>
      <button
        onClick={refetch}
        className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
        style={{ background: '#ef444430', color: '#f87171' }}>
        Retry
      </button>
    </div>
  )
  if (!summary) return null

  const { libraries = [], disk_mounts = [], primary_mount_forecast, days_remaining } = summary

  const hasData = disk_mounts.length > 0 || libraries.some(l => l.item_count != null)

  const NotConnectedBanner = () => (
    <div className="rounded-xl px-5 py-4 flex items-center justify-between gap-4 flex-wrap"
      style={{ background: '#e5a00d18', border: `1px solid ${T.accent}60` }}>
      <p className="text-sm" style={{ color: T.textPrimary }}>
        Plex not connected — go to Settings to sign in with your Plex account
      </p>
      <Link
        to="/settings"
        className="px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0"
        style={{ background: T.accent, color: '#000' }}>
        Go to Settings
      </Link>
    </div>
  )
  if (!hasData) {
    return (
      <div className="space-y-4">
        {settingsData && !plexConfigured && <NotConnectedBanner />}
        <div className="rounded-xl p-10 flex flex-col items-center gap-5 text-center"
          style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <div className="text-4xl">📦</div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold" style={{ color: T.textPrimary }}>No snapshots yet</h3>
          <p className="text-sm max-w-xs" style={{ color: T.textMuted }}>
            PlexPulse collects data on a schedule. Click below to collect your first snapshot.
          </p>
        </div>
        <button
          onClick={handleCollect}
          disabled={collectingNow}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50"
          style={{ background: T.accent, color: '#000' }}>
          {collectingNow ? '⟳ Running…' : 'Run Collection Now'}
        </button>
        </div>
      </div>
    )
  }

  const totalDiskUsed = disk_mounts.reduce((s, d) => s + d.used_bytes, 0)
  const primaryDisk   = disk_mounts.length
    ? disk_mounts.reduce((a, b) => a.used_bytes > b.used_bytes ? a : b)
    : null

  const byType = (...types) => libraries.find(l => types.includes(l.type))
  const movies = byType('movie')
  const shows  = byType('show')
  const music  = byType('artist', 'music')

  const monthlyItemsSub = lib => {
    if (!lib) return 'No library'
    const n = growthData[lib.id]?.avg_monthly_item_growth
    return n != null ? `+${Math.round(n)} added/month` : 'Trend pending'
  }

  const freeSpaceTB = primaryDisk ? fmtBytes(primaryDisk.free_bytes) : '—'
  const freeSub     = days_remaining != null
    ? `~${Math.round(days_remaining / 30)} months remaining`
    : 'Forecast pending'

  return (
    <div className="space-y-5">
      {settingsData && !plexConfigured && <NotConnectedBanner />}
      {/* 1 — Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Movies"    value={(movies?.item_count ?? 0).toLocaleString()} sub={monthlyItemsSub(movies)} />
        <StatCard title="TV Shows"  value={(shows?.item_count  ?? 0).toLocaleString()} sub={monthlyItemsSub(shows)} />
        <StatCard title="Music"     value={(music?.item_count  ?? 0).toLocaleString()} sub={monthlyItemsSub(music)} />
        <StatCard
          title="Free Space" value={freeSpaceTB} sub={freeSub}
          valueColor={daysColor(days_remaining)}
        />
      </div>

      {/* 2 — Library donuts */}
      {libraries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {libraries.map(lib => (
            <LibraryDonut key={lib.id} library={lib} totalDiskUsed={totalDiskUsed} growth={growthData[lib.id]} />
          ))}
        </div>
      )}

      {/* 3 — Storage over time */}
      <StorageChart
        libraries={libraries} snapshots={librarySnapshots}
        range={range} onRangeChange={setRange} loading={snapshotsLoading}
      />

      {/* 4 — Monthly growth table */}
      <GrowthTable libraries={libraries} growthData={growthData} />

      {/* 5 — Burndown */}
      <BurndownChart
        diskSnapshots={diskSnapshots}
        forecast={diskForecast || primary_mount_forecast}
        daysRemaining={days_remaining}
      />
    </div>
  )
}
