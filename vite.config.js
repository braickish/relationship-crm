import { defineConfig, loadEnv } from 'vite';

// The built site gets a strict Content Security Policy: it may load only its own files and talk
// only to its Supabase project. GitHub Pages can't send headers, so the policy is a <meta> tag.
// It's added to builds only, because the dev server needs inline scripts and a websocket.
function contentSecurityPolicy(supabaseUrl) {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${supabaseUrl}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: html =>
      html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`),
  };
}

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example).');
  }
  if (/service_role|sb_secret_/.test(env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY is a secret key. Use the publishable key instead.');
  }
  return {
    base: command === 'build' || isPreview ? '/relationship-crm/' : '/',
    plugins: [contentSecurityPolicy(new URL(env.VITE_SUPABASE_URL).origin)],
    build: { sourcemap: false, assetsInlineLimit: 0 },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  };
});
