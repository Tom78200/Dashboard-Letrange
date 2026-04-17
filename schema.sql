-- ══════════════════════════════════════════════════════
-- Letrange Content Board — Supabase Database Schema
-- Run this in your Supabase SQL Editor
-- ══════════════════════════════════════════════════════

-- 1. Tables Creation
CREATE TABLE IF NOT EXISTS public.weeks (
    id SERIAL PRIMARY KEY,
    number INTEGER NOT NULL,
    cards JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.images (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    cat TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 2. Storage Bucket Creation (Manual step in Supabase UI recommended)
-- Ensure a bucket named 'gallery' exists with public access checked or via RLS

-- 3. Security (RLS)
ALTER TABLE public.weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.images ENABLE ROW LEVEL SECURITY;

-- 4. Policies (Only allow users to access their own data)
CREATE POLICY "Users can only see their own weeks" 
ON public.weeks FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can only insert their own weeks" 
ON public.weeks FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can only update their own weeks" 
ON public.weeks FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can only delete their own weeks" 
ON public.weeks FOR DELETE 
USING (auth.uid() = user_id);

-- Repeating for images
CREATE POLICY "Users can only see their own images" 
ON public.images FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can only insert their own images" 
ON public.images FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can only update their own images" 
ON public.images FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can only delete their own images" 
ON public.images FOR DELETE 
USING (auth.uid() = user_id);
