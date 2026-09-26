import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './index.css';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    tracesSampleRate: 0.1,
    release: import.meta.env.VITE_GIT_SHA || '1.0.0',
    environment: import.meta.env.MODE || 'production',
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Gracefully dismiss splash screens (both Web/PWA HTML overlay and Native Capacitor)
function dismissSplash() {
  const splashEl = document.getElementById('app-splash');
  if (splashEl) {
    splashEl.classList.add('fade-out');
    setTimeout(() => {
      if (splashEl.parentNode) splashEl.parentNode.removeChild(splashEl);
    }, 550);
  }
  // If running in Capacitor native container
  import('@capacitor/splash-screen')
    .then(({ SplashScreen }) => {
      SplashScreen.hide({ fadeOutDuration: 500 }).catch(() => {});
    })
    .catch(() => {});
}

// Allow initial paint before initiating fade-out
if (typeof window !== 'undefined') {
  requestAnimationFrame(() => {
    setTimeout(dismissSplash, 60);
  });
}

// PWA: register the service worker after the page is interactive.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
