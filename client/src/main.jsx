import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, readPref } from './prefs.js';
import './styles.css';

// Before the first render, so a chosen theme doesn't flash the other one.
applyTheme(readPref('theme', 'system'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
