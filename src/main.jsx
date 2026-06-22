import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Production: server-side state at /api/state (syncs across devices)
// Dev: localStorage (no server running)
if (!window.storage) {
  window.storage = import.meta.env.PROD
    ? {
        get: async (key) => {
          const res = await fetch(`/api/state?key=${encodeURIComponent(key)}`)
          return res.ok ? res.json() : null
        },
        set: async (key, value) => {
          await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value }),
          })
        },
        delete: async (key) => {
          await fetch(`/api/state?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
        },
      }
    : {
        get: async (key) => {
          const v = localStorage.getItem(key)
          return v ? { value: v } : null
        },
        set: async (key, value) => localStorage.setItem(key, value),
        delete: async (key) => localStorage.removeItem(key),
      }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
