import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The daemon serves dist/ on :4317; in dev, proxy the data routes there.
const api = 'http://127.0.0.1:4317';
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/runs': api, '/snapshot': api, '/events': api, '/plan': api } },
});
