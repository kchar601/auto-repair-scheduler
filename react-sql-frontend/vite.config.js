import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendTarget = process.env.VITE_BACKEND_URL || 'https://localhost:443'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
  server: {
    proxy: {
      '/users': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/schedule': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/appointments': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/appointment-locks': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/realtime': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
