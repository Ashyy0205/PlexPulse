import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Shell from './layouts/Shell'
import Dashboard from './pages/Dashboard'
import LibraryDetail from './pages/LibraryDetail'
import Forecast from './pages/Forecast'
import Drives from './pages/Drives'
import Alerts from './pages/Alerts'
import Settings from './pages/Settings'
import { ToastProvider } from './components/Toast'

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="/library/:id" element={<LibraryDetail />} />
            <Route path="/forecast" element={<Forecast />} />
            <Route path="/drives" element={<Drives />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}
