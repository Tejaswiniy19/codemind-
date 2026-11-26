import React from 'react'
import ReactDOM from 'react-dom/client'
import AuthGate from './AuthGate'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>{({ csrfToken, logout, username }) => <App csrfToken={csrfToken} onLogout={logout} username={username} />}</AuthGate>
  </React.StrictMode>,
)
