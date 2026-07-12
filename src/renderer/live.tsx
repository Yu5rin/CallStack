import React from 'react';
import ReactDOM from 'react-dom/client';
import { LiveApp } from './LiveApp';
import './index.css';

const root = document.getElementById('live-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <LiveApp />
    </React.StrictMode>,
  );
}
