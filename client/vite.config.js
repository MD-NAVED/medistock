import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

// Use relative paths for Capacitor (Android) builds, absolute for web
const isCapacitor = process.env.CAPACITOR_BUILD === 'true';

let gitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VITE_GIT_SHA;
if (!gitSha) {
  try {
    gitSha = execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    gitSha = '1.0.0';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_GIT_SHA': JSON.stringify(gitSha),
  },
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
