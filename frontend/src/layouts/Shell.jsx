import { Outlet, NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import axios from 'axios'

const NAV = [
  { label: 'Dashboard', to: '/', icon: '⊞' },
  {
    label: 'Libraries',
    icon: '▤',
    children: [
      { label: 'Movies',   to: '/library/movies' },
      { label: 'TV Shows', to: '/library/shows' },
      { label: 'Music',    to: '/library/music' },
    ],
  },
  { label: 'Forecast',  to: '/forecast',  icon: '◈' },
  { label: 'Drives',    to: '/drives',    icon: '◫' },
  { label: 'Alerts',    to: '/alerts',    icon: '◉' },
  { label: 'Settings',  to: '/settings',  icon: '⚙' },
]

function StatusPill({ connected }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full
      bg-surface-raised border border-surface-border">
      <span className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-zinc-500'}`} />
      {connected ? 'Plex Connected' : 'Plex Offline'}
    </span>
  )
}

function NavItem({ item }) {
  const [open, setOpen] = useState(true)

  if (item.children) {
    return (
      <li>
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400
            hover:text-zinc-100 hover:bg-surface-raised transition-colors"
        >
          <span>{item.icon}</span>
          <span className="flex-1 text-left">{item.label}</span>
          <span className="text-xs">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <ul className="ml-6 mt-0.5 space-y-0.5">
            {item.children.map(child => (
              <NavItem key={child.to} item={child} />
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <li>
      <NavLink
        to={item.to}
        end={item.to === '/'}
        className={({ isActive }) =>
          `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
            isActive
              ? 'bg-accent/10 text-accent font-medium'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-surface-raised'
          }`
        }
      >
        {item.icon && <span>{item.icon}</span>}
        {item.label}
      </NavLink>
    </li>
  )
}

export default function Shell() {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const check = () =>
      axios.get('/health')
        .then(r => setConnected(r.data?.plex_connected ?? false))
        .catch(() => setConnected(false))
    check()
    const id = setInterval(check, 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-zinc-100">
      {/* Sidenav */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-surface-border bg-surface">
        <div className="h-14 flex items-center px-4 border-b border-surface-border">
          <span className="text-accent font-bold text-lg tracking-tight">PlexPulse</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-0.5">
            {NAV.map(item => (
              <NavItem key={item.label} item={item} />
            ))}
          </ul>
        </nav>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 flex items-center justify-between px-6 border-b border-surface-border
          bg-surface flex-shrink-0">
          <h1 className="text-sm font-semibold text-zinc-300">PlexPulse</h1>
          <StatusPill connected={connected} />
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
