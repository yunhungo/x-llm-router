import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { ThemeProvider } from './components/theme-provider';
import { initializeTheme } from './theme';

initializeTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
