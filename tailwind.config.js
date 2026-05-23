/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './hud.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcd9ff',
          300: '#8dc1ff',
          400: '#5b9eff',
          500: '#367aff',
          600: '#1f5af0',
          700: '#1a47cf',
          800: '#1a3ca6',
          900: '#1b3683',
        },
      },
    },
  },
  plugins: [],
};
