/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#18181b',
          raised: '#27272a',
          border: '#3f3f46',
        },
        accent: {
          DEFAULT: '#e6a817',
          hover: '#f5bc35',
        },
      },
    },
  },
  plugins: [],
}
