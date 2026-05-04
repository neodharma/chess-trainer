import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Viz from './Viz.jsx'
import './index.css'

const Root = window.location.pathname.startsWith('/viz') ? Viz : App

ReactDOM.createRoot(document.getElementById('root')).render(
  <Root />
)