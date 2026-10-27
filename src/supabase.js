import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } },
);

// PostgREST returns at most 1,000 rows per request, so page through larger tables.
export async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// Turns database errors into sentences a person can act on.
export function describeError(error) {
  const code = error?.code;
  if (code === 'P0001') return error.message;
  if (code === '42501') return "You don't have permission to change this project.";
  if (code === '23514') return 'That entry is empty or too long.';
  if (code === '23503') return 'One of those elements no longer exists. Refresh and try again.';
  if (code === '23505') return 'That connection already exists.';
  if (error?.status === 429 || /rate limit/i.test(error?.message || '')) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (!navigator.onLine || /failed to fetch|networkerror|load failed/i.test(error?.message || '')) {
    return 'Can’t reach the server. Check your connection; your text is still there to try again.';
  }
  return error?.message || 'Something went wrong. Refresh and try again.';
}
