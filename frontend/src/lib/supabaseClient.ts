import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Check your .env file.',
  );
}

// Browser-safe client: uses only the publishable (anon) key, never a
// secret/service-role key. It authenticates the user only — it never
// queries application database tables directly.
export const supabase = createClient(supabaseUrl, supabasePublishableKey);
