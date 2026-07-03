import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser calls the API directly (CORS is enabled server-side). Override the base URL
// with VITE_API_URL at build/dev time if the API isn't on localhost:4000.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
