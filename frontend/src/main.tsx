import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './app/AppRouter';
import { AuthProvider } from './auth/AuthProvider';
import { registerServiceWorker } from './pwa/register';
import { ToastProvider } from './ui/Toast';
import './styles/tokens.css';
import './styles/base.css';
import './ui/ui.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container is missing from the page');

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <AppRouter />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);

// Installed only in a production build. It caches the application SHELL
// and nothing else - see `public/sw.js`.
registerServiceWorker();
