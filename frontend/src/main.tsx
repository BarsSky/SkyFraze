import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import './styles/tokens.css'
import './styles/timeline.css'
import './styles/editors.css'
import './styles/feed.css'
import './styles/coauthors.css'
import './styles/people.css'
import './styles/markdown.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
