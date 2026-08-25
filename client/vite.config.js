import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Use relative paths for Capacitor (Android) builds, absolute for web
const isCapacitor = process.env.CAPACITOR_BUILD === 'true';

export default defineConfig({
  plugins: [react()],
  base: isCapacitor ? './' : '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3001',
        changeOrigin: true,
      }
    },
  },
});
