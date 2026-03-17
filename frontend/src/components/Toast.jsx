import { createContext, useContext, useState, useCallback } from 'react'

const ToastContext = createContext(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

let _nextId = 0

const STYLES = {
  success: { border: '#22c55e40', icon: '✓', color: '#86efac' },
  error:   { border: '#ef444440', icon: '✕', color: '#f87171' },
  info:    { border: '#e5a00d40', icon: 'ℹ', color: '#fbbf24' },
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id))
  }, [])

  const addToast = useCallback((message, type = 'info') => {
    const id = ++_nextId
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => dismiss(id), 4000)
  }, [dismiss])

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      <div
        className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
        style={{ maxWidth: 320 }}
      >
        {toasts.map(({ id, message, type }) => {
          const s = STYLES[type] || STYLES.info
          return (
            <div
              key={id}
              className="flex items-start gap-3 px-4 py-3 rounded-xl text-sm pointer-events-auto shadow-lg"
              style={{ background: '#111114', border: `1px solid ${s.border}` }}
            >
              <span style={{ color: s.color, flexShrink: 0, lineHeight: '1.4' }}>{s.icon}</span>
              <span className="flex-1" style={{ color: '#f0ede4' }}>{message}</span>
              <button
                onClick={() => dismiss(id)}
                className="flex-shrink-0 cursor-pointer leading-none"
                style={{ color: '#6b6960' }}
              >×</button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
