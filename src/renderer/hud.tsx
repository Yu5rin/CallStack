import React from 'react';
import ReactDOM from 'react-dom/client';
import { HudApp } from './HudApp';
// フォントはオフラインでも表示できるよう npm パッケージからバンドルする（CDN 参照はしない）
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';

const root = document.getElementById('hud-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <HudApp />
    </React.StrictMode>,
  );
}
