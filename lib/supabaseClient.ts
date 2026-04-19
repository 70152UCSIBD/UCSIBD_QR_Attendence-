import { createClient } from '@supabase/supabase-js';

// Ensure these environment variables are set in .env.local or Netlify
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Supabase URL or Anon Key is missing. Check .env.local');
  // In a real application, you might want to throw an error or handle this more gracefully
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');
