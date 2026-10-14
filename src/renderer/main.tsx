import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ComposeWindow from './components/ComposeWindow'
import ContactsWindow from './components/ContactsWindow'
import './styles/index.css'

const composeData = window.nvelope.composeData
const windowData = window.nvelope.windowData

// Theme groundwork: record the saved preference on the root element.
// The UI is dark-only for now; this is honored once a light palette lands.
window.nvelope.settings.get('theme').then((theme) => {
  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    document.documentElement.dataset.theme = theme
  }
})

const rootEl = document.getElementById('root')
if (!rootEl) {
  document.body.innerHTML = '<div style="padding:20px;color:red">Fatal: root element not found</div>'
} else {
  try {
    if (composeData) {
      // Compose window mode
      ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
          <ComposeWindow data={composeData} />
        </React.StrictMode>,
      )
    } else if (windowData?.mode === 'contacts') {
      // Address book window mode
      ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
          <ContactsWindow data={windowData} />
        </React.StrictMode>,
      )
    } else {
      ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      )
    }
  } catch (err) {
    rootEl.innerHTML = `<div style="padding:20px"><h2 style="color:red">Render Error</h2><pre style="white-space:pre-wrap">${String(err)}</pre></div>`
    console.error('[renderer] Fatal render error:', err)
  }
}
