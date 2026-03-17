import { useState, useEffect } from 'react'
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
  card:        '#111114',
  border:      '#1e1e24',
  accent:      '#e5a00d',
  textPrimary: '#f0ede4',
  textMuted:   '#6b6960',
}

const CHART_TOOLTIP = {
  backgroundColor: T.card,
  borderColor:     T.border,
  borderWidth:     1,
  titleColor:      T.textMuted,
  bodyColor:       T.textPrimary,
}

const DISPLAY_RANGES = ['6m', '1y', '2y']
const DISPLAY_DAYS   = { '6m': 180, '1y': 365, '2y': 730 }

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtDate = iso => iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
  : ''
const fmtDateLong = iso => iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  : ''
const fmtGB = (b, dp = 1) => b != null ? (b / 1e9).toFixed(dp) : '—'

function fmtBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

// ── Exhaustion vertical line plugin (per-chart, no global registration) ────────
function makeExhaustionPlugin(exhaustLabel) {
  return {
    id: 'exLine',
    afterDraw(chart) {
      if (!exhaustLabel) return
      const xScale = chart.scales.x
      const yScale = chart.scales.y
      if (!xScale || !yScale) return
      const idx = chart.data.labels.indexOf(exhaustLabel)
      if (idx < 0) return
      const x   = xScale.getPixelForValue(idx)
      const ctx = chart.ctx
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(x, yScale.top)
      ctx.lineTo(x, yScale.bottom)
      ctx.lineWidth   = 1.5
      ctx.strokeStyle = '#ef4444'
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle   = '#ef4444'
      ctx.font        = '10px system-ui, sans-serif'
      ctx.textAlign   = 'center'
      ctx.fillText('Full', x, yScale.top + 14)
      ctx.restore()
    },
  }
}

// ── Local what-if forecast ─────────────────────────────────────────────────────
function buildLocalForecast(currentFreeBytes, monthlyGrowthGB, addTB, addInMonths, days) {
  const dailyDecline = (monthlyGrowthGB * 1e9) / 30
  const addBytes     = addTB * 1e12
  const addAfterDays = addInMonths * 30
  const t0           = Date.now()
  const points       = []
  let exhaustionDate = null
  for (let d = 0; d <= days; d += 7) {
    let free = currentFreeBytes - dailyDecline * d
    if (addTB > 0 && d >= addAfterDays) free += addBytes
    if (free <= 0 && !exhaustionDate) {
      exhaustionDate = new Date(t0 + d * 86400 * 1000).toISOString()
    }
    points.push({ date: new Date(t0 + d * 86400 * 1000).toISOString(), free_bytes: Math.max(free, 0) })
  }
  return { points, exhaustionDate }
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function Sk({ className = '' }) {
  return <div className={`animate-pulse rounded bg-[#1e1e24] ${className}`} />
}
function SkeletonPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-xl p-6 space-y-3" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <Sk className="h-3 w-48" />
        <Sk className="h-9 w-3/4" />
        <Sk className="h-3 w-64" />
      </div>
      <div className="rounded-xl p-6 space-y-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <Sk className="h-4 w-40" /><Sk className="h-80" />
      </div>
      <div className="rounded-xl p-6 space-y-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <Sk className="h-4 w-32" /><Sk className="h-6 w-full" /><Sk className="h-10" />
      </div>
    </div>
  )
}

// ── RangeTabs ─────────────────────────────────────────────────────────────────
function RangeTabs({ range, onChange }) {
  return (
    <div className="flex gap-1.5">
      {DISPLAY_RANGES.map(r => (
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

// ── BurndownChart ─────────────────────────────────────────────────────────────
function BurndownChart({ histData, apiForecast, whatIfPts, range }) {
  const now        = Date.now()
  const histCutoff = new Date(now - DISPLAY_DAYS[range] * 86400 * 1000)
  const fcCutoff   = new Date(now + DISPLAY_DAYS[range] * 86400 * 1000)

  const hist  = histData.filter(d => new Date(d.captured_at) >= histCutoff)
  const fcPts = (apiForecast?.forecast_points ?? []).filter(p => new Date(p.date) <= fcCutoff)
  const fcLow = (apiForecast?.confidence_low  ?? []).filter(p => new Date(p.date) <= fcCutoff)
  const fcHi  = (apiForecast?.confidence_high ?? []).filter(p => new Date(p.date) <= fcCutoff)
  const wiPts = whatIfPts.filter(p => new Date(p.date) <= fcCutoff)

  const histLbls = hist.map(d => fmtDate(d.captured_at))
  const fcLbls   = fcPts.map(p => fmtDate(p.date))
  const wiLbls   = wiPts.map(p => fmtDate(p.date))
  const allLbls  = [...new Set([...histLbls, ...fcLbls, ...wiLbls])]

  function align(srcLbls, srcVals) {
    const m = Object.fromEntries(srcLbls.map((l, i) => [l, srcVals[i]]))
    return allLbls.map(l => m[l] ?? null)
  }

  const exhaustLabel = apiForecast?.projected_exhaustion_date
    ? fmtDate(apiForecast.projected_exhaustion_date)
    : null

  const datasets = [
    {
      label: 'Free Space',
      data: align(histLbls, hist.map(d => d.free_bytes / 1e12)),
      borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.07)',
      fill: true, tension: 0.35, spanGaps: false,
      pointRadius: histLbls.length > 50 ? 0 : 2, pointHoverRadius: 4,
    },
    {
      label: 'Forecast',
      data: align(fcLbls, fcPts.map(p => p.free_bytes / 1e12)),
      borderColor: T.accent, borderDash: [6, 3], backgroundColor: 'transparent',
      fill: false, tension: 0.35, spanGaps: false, pointRadius: 0,
    },
    {
      label: 'CI Low',
      data: align(fcLbls, fcLow.map(p => p.free_bytes / 1e12)),
      borderColor: 'transparent', backgroundColor: T.accent + '18',
      fill: '+1', tension: 0.35, spanGaps: false, pointRadius: 0,
    },
    {
      label: 'CI High',
      data: align(fcLbls, fcHi.map(p => p.free_bytes / 1e12)),
      borderColor: 'transparent', backgroundColor: 'transparent',
      fill: false, tension: 0.35, spanGaps: false, pointRadius: 0,
    },
  ]

  if (wiPts.length) {
    datasets.push({
      label: 'What-if',
      data: align(wiLbls, wiPts.map(p => p.free_bytes / 1e12)),
      borderColor: '#a855f7', borderDash: [3, 2], backgroundColor: 'transparent',
      fill: false, tension: 0.35, spanGaps: false, pointRadius: 0,
    })
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: T.textMuted, boxWidth: 10, padding: 14, font: { size: 11 },
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
      x: { ticks: { color: T.textMuted, maxTicksLimit: 12, maxRotation: 0, font: { size: 11 } }, grid: { color: T.border + '80' } },
      y: { min: 0, ticks: { color: T.textMuted, font: { size: 11 }, callback: v => `${Number(v).toFixed(1)} TB` }, grid: { color: T.border + '80' } },
    },
  }

  return allLbls.length > 1
    ? <Line data={{ labels: allLbls, datasets }} options={options} plugins={[makeExhaustionPlugin(exhaustLabel)]} />
    : <div className="h-full flex items-center justify-center text-sm" style={{ color: T.textMuted }}>Not enough data to draw a chart yet.</div>
}

// ── Forecast page ─────────────────────────────────────────────────────────────
export default function Forecast() {
  const [diskMounts,   setDiskMounts]   = useState([])
  const [diskHist,     setDiskHist]     = useState([])
  const [forecast,     setForecast]     = useState(null)
  const [libraries,    setLibraries]    = useState([])
  const [libGrowth,    setLibGrowth]    = useState({})
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [retryKey,     setRetryKey]     = useState(0)
  const [range,        setRange]        = useState('1y')
  const [whatIfGB,     setWhatIfGB]     = useState(0)
  const [addStorageTB, setAddStorageTB] = useState(0)
  const [addInMonths,  setAddInMonths]  = useState(6)
  const [whatIfFc,     setWhatIfFc]     = useState({ points: [], exhaustionDate: null })

  // Initial data load
  useEffect(() => {
    setLoading(true)
    const m = encodeURIComponent('/')
    Promise.all([
      client.get('/disk').then(r => r.data).catch(() => []),
      client.get(`/disk/forecast?mount=${m}&days=730`).then(r => r.data).catch(() => null),
      client.get(`/disk/snapshots?mount=${m}&range=max`).then(r => r.data).catch(() => []),
      client.get('/libraries').then(r => r.data).catch(() => []),
    ]).then(async ([mounts, fc, hist, libs]) => {
      setDiskMounts(mounts)
      setForecast(fc)
      setDiskHist(hist)
      setLibraries(libs)
      const rate = fc?.monthly_growth_bytes != null ? Math.round(fc.monthly_growth_bytes / 1e9) : 0
      setWhatIfGB(rate)
      if (libs.length) {
        const pairs = await Promise.all(
          libs.map(l => client.get(`/libraries/${l.id}/growth`).then(r => [l.id, r.data]).catch(() => [l.id, null]))
        )
        setLibGrowth(Object.fromEntries(pairs))
      }
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [retryKey])

  // Rebuild what-if whenever inputs change
  const primaryDisk = diskMounts.length
    ? diskMounts.reduce((a, b) => a.used_bytes > b.used_bytes ? a : b)
    : null

  useEffect(() => {
    if (!primaryDisk) return
    setWhatIfFc(buildLocalForecast(primaryDisk.free_bytes, whatIfGB, addStorageTB, addInMonths || 9999, 730))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whatIfGB, addStorageTB, addInMonths, primaryDisk?.free_bytes])

  if (loading) return <SkeletonPage />
  if (error) return (
    <div className="rounded-xl p-6 space-y-3"
      style={{ background: '#ef444415', border: '1px solid #ef4444' }}>
      <p className="text-sm" style={{ color: '#f87171' }}>Error loading forecast: {error}</p>
      <button
        onClick={() => { setError(null); setLoading(true); setRetryKey(k => k + 1) }}
        className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
        style={{ background: '#ef444430', color: '#f87171' }}>
        Retry
      </button>
    </div>
  )

  // ── Derived values ─────────────────────────────────────────────────────────
  const apiGrowthGB   = forecast?.monthly_growth_bytes != null ? forecast.monthly_growth_bytes / 1e9 : null
  const daysRemaining = forecast?.days_remaining
  const monthsRem     = daysRemaining != null ? Math.round(daysRemaining / 30) : null
  const exhaustDate   = forecast?.projected_exhaustion_date

  const summaryColor = daysRemaining == null ? T.textPrimary
    : daysRemaining < 90  ? '#ef4444'
    : daysRemaining < 180 ? T.accent
    : T.textPrimary

  const summarySentence = apiGrowthGB != null && monthsRem != null
    ? `At current growth (${fmtGB(forecast.monthly_growth_bytes, 0)} GB/month), your primary drive will be full in approximately ${monthsRem} months.`
    : apiGrowthGB != null
    ? `Current growth rate: ${fmtGB(forecast.monthly_growth_bytes, 0)} GB/month. No exhaustion projected within 2 years.`
    : 'Collect more snapshots to enable storage runway forecasting.'

  // Library table sorted by growth descending
  const libRows = libraries
    .map(lib => ({
      ...lib,
      monthlyGB: libGrowth[lib.id]?.avg_monthly_growth_bytes != null
        ? libGrowth[lib.id].avg_monthly_growth_bytes / 1e9 : null,
    }))
    .filter(r => r.monthlyGB != null && r.monthlyGB > 0)
    .sort((a, b) => b.monthlyGB - a.monthlyGB)
    .map(r => ({
      ...r,
      fillMonths: primaryDisk
        ? (primaryDisk.free_bytes / 1e9 / r.monthlyGB).toFixed(1)
        : null,
    }))

  const fastest = libRows[0]

  const recommendation = fastest && primaryDisk
    ? `${fastest.name} is your fastest-growing library at ${fastest.monthlyGB.toFixed(0)} GB/month. `
      + (exhaustDate
        ? `At this rate, you should plan to add storage before ${fmtDateLong(exhaustDate)}.`
        : 'At this rate, storage will remain within safe limits for the next two years.')
      + ` Consider archiving older content or expanding capacity by at least ${Math.ceil(fastest.monthlyGB * 6 / 1000)} TB.`
    : 'Add more snapshots to generate a personalised recommendation. Data is collected on the interval configured in Settings.'

  // Only overlay the what-if line when it actually differs from the API scenario
  const apiRateRounded = Math.round(apiGrowthGB ?? 0)
  const showWhatIf     = whatIfGB !== apiRateRounded || addStorageTB > 0

  return (
    <div className="space-y-6" style={{ color: T.textPrimary }}>

      {/* 1 — Headline summary */}
      <div className="rounded-xl p-6" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: T.textMuted }}>
          Storage Runway Forecast
        </p>
        <p className="text-2xl font-bold leading-snug" style={{ color: summaryColor }}>
          {summarySentence}
        </p>
        {exhaustDate && (
          <p className="mt-1.5 text-sm" style={{ color: T.textMuted }}>
            Projected full:&nbsp;
            <span style={{ color: summaryColor }}>{fmtDateLong(exhaustDate)}</span>
            &nbsp;·&nbsp;Based on {diskHist.length} historical data point{diskHist.length !== 1 ? 's' : ''}.
          </p>
        )}
      </div>

      {/* 2 — Burndown chart */}
      <div className="rounded-xl p-6" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>
            Primary Drive — Free Space
          </h3>
          <RangeTabs range={range} onChange={setRange} />
        </div>
        <div style={{ height: 340 }}>
          <BurndownChart
            histData={diskHist}
            apiForecast={forecast}
            whatIfPts={showWhatIf ? whatIfFc.points : []}
            range={range}
          />
        </div>
      </div>

      {/* 3 — What-if panel */}
      <div className="rounded-xl p-6 space-y-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>What-if Scenarios</h3>

        {/* Growth slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium" style={{ color: T.textMuted }}>
              Assumed monthly growth
            </label>
            <span className="text-sm font-bold tabular-nums" style={{ color: T.accent }}>
              {whatIfGB} GB/month
            </span>
          </div>
          <input
            type="range" min={0} max={2000} step={10}
            value={whatIfGB}
            onChange={e => setWhatIfGB(Number(e.target.value))}
            className="w-full cursor-pointer accent-amber-500"
          />
          <div className="flex justify-between text-xs" style={{ color: T.textMuted }}>
            <span>0 GB</span>
            {apiGrowthGB != null && (
              <span style={{ color: T.accent }}>▲ Current: {apiGrowthGB.toFixed(0)} GB</span>
            )}
            <span>2,000 GB</span>
          </div>
        </div>

        {/* Storage step-up */}
        <div>
          <h4 className="text-xs font-medium mb-3" style={{ color: T.textMuted }}>
            Add storage step-up
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs" style={{ color: T.textMuted }}>Adding (TB)</label>
              <input
                type="number" min={0} max={999} step={1}
                value={addStorageTB || ''}
                placeholder="0"
                onChange={e => setAddStorageTB(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: '#1e1e24', color: T.textPrimary, border: '1px solid #2a2a32' }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs" style={{ color: T.textMuted }}>In how many months</label>
              <input
                type="number" min={0} max={60} step={1}
                value={addInMonths || ''}
                placeholder="6"
                onChange={e => setAddInMonths(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: '#1e1e24', color: T.textPrimary, border: '1px solid #2a2a32' }}
              />
            </div>
          </div>
        </div>

        {/* What-if result pill */}
        {showWhatIf && (
          whatIfFc.exhaustionDate ? (
            <div className="px-4 py-3 rounded-lg text-sm"
              style={{ background: '#ef444418', border: '1px solid #ef444650', color: '#f87171' }}>
              Scenario: at {whatIfGB} GB/month
              {addStorageTB > 0 ? ` with +${addStorageTB} TB in ${addInMonths} months` : ''} —
              projected full: <strong>{fmtDateLong(whatIfFc.exhaustionDate)}</strong>
            </div>
          ) : (
            <div className="px-4 py-3 rounded-lg text-sm"
              style={{ background: '#22c55e18', border: '1px solid #22c55e40', color: '#86efac' }}>
              Scenario: at {whatIfGB} GB/month
              {addStorageTB > 0 ? ` with +${addStorageTB} TB in ${addInMonths} months` : ''} —
              disk stays within capacity for the entire 2-year window.
            </div>
          )
        )}
      </div>

      {/* 4 — Per-library breakdown */}
      <div className="rounded-xl p-6" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <h3 className="text-sm font-semibold mb-4" style={{ color: T.textPrimary }}>
          Library Growth Breakdown
        </h3>
        {libRows.length === 0 ? (
          <p className="text-sm" style={{ color: T.textMuted }}>
            Not enough history to calculate growth rates yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {['Library', 'Current Size', 'Growth / month', 'Fills remaining space in'].map((h, i) => (
                    <th key={h}
                      className={`pb-3 text-xs font-medium uppercase tracking-wider ${i === 0 ? 'text-left' : 'text-right'}`}
                      style={{ color: T.textMuted }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {libRows.map(row => {
                  const fm    = row.fillMonths ? parseFloat(row.fillMonths) : null
                  const fmClr = fm != null && fm < 3 ? '#ef4444' : fm != null && fm < 6 ? T.accent : T.textPrimary
                  return (
                    <tr key={row.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td className="py-3" style={{ color: T.textPrimary }}>{row.name}</td>
                      <td className="py-3 text-right tabular-nums" style={{ color: T.textMuted }}>
                        {fmtBytes(row.total_size_bytes)}
                      </td>
                      <td className="py-3 text-right tabular-nums font-medium" style={{ color: T.accent }}>
                        +{row.monthlyGB.toFixed(1)} GB
                      </td>
                      <td className="py-3 text-right tabular-nums" style={{ color: fmClr }}>
                        {row.fillMonths != null ? `~${row.fillMonths} mo` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 5 — Recommendation */}
      <div className="rounded-xl p-6" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <div className="flex items-center gap-2 mb-3">
          <span style={{ color: T.accent }}>💡</span>
          <h3 className="text-sm font-semibold" style={{ color: T.textPrimary }}>Recommendation</h3>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: T.textMuted }}>{recommendation}</p>
      </div>

    </div>
  )
}

