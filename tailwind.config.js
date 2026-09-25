/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './hud.html', './live.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Pane のデザインシステム（仕様書 10章）を移植したトークン。
        // 実体は src/renderer/index.css の CSS 変数（:root / html.dark / html.dark.black）。
        paper: 'rgb(var(--c-paper) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        chrome: 'rgb(var(--c-chrome) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
          mute: 'rgb(var(--c-ink-mute) / <alpha-value>)',
        },
        rule: 'rgb(var(--c-rule) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          ink: 'rgb(var(--c-accent-ink) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
        },
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          soft: 'rgb(var(--c-danger-soft) / <alpha-value>)',
        },
        pending: 'rgb(var(--c-pending) / <alpha-value>)',
        meeting: 'rgb(var(--c-meeting) / <alpha-value>)',
        ok: {
          DEFAULT: 'rgb(var(--c-ok) / <alpha-value>)',
          soft: 'rgb(var(--c-ok-soft) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Yu Gothic UI', 'Meiryo UI', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'Consolas', 'monospace'],
      },
      // 半径: controls は rounded-md（6px）, panels/dialogs は rounded-lg（8px）を
      // そのまま使う（Tailwind の既定値と一致するため上書き不要）。
    },
  },
  plugins: [],
};
