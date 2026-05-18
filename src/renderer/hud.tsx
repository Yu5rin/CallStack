import React from 'react';
import ReactDOM from 'react-dom/client';
import { HudApp } from './HudApp';
import './index.css';

const root = document.getElementById('hud-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <HudApp />
    </React.StrictMode>,
  );
}
