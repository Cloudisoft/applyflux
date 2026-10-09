import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from './api';
import { supabase } from './supabase';
import { useAuth } from './auth';
import type {
  Application,
  AutomationState,
  CoverLetter,
  Dashboard,
  Doc,
  Job,
  Me,
  Notification,
  Paginated,
  Platform,
  ProfileResponse,
  SavedAnswer,
  Source,
  Usage,
} from './types';

export const qk = {
  me: ['me'] as const,
  profile: ['profile'] as const,
  dashboard: ['dashboard'] as const,
  automation: ['automation'] as const,
  applications: (f: object) => ['applications', f] as const,
  application: (id: string) => ['application', id] as const,
  jobs: (f: object) => ['jobs', f] as const,
  job: (id: string) => ['job', id] as const,
  documents: (kind?: string) => ['documents', kind ?? 'all'] as const,
  answers: ['answers'] as const,
  coverLetters: ['cover-letters'] as const,
  notifications: ['notifications'] as const,
  usage: ['usage'] as const,
  sources: ['sources'] as const,
  savedSearches: ['saved-searches'] as const,
  connections: ['ext-connections'] as const,
  platforms: ['platforms'] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api.get<Me>('/me') });
export const useProfile = () => useQuery({ queryKey: qk.profile, queryFn: () => api.get<ProfileResponse>('/profile') });
export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: () => api.get<Dashboard>('/dashboard'), refetchInterval: 15_000 });
export const useAutomation = () => useQuery({ queryKey: qk.automation, queryFn: () => api.get<AutomationState>('/automation'), refetchInterval: 5_000 });
export const useApplications = (f: { state?: string[]; q?: string; page?: number }) =>
  useQuery({
    queryKey: qk.applications(f),
    queryFn: () => {
      const p = new URLSearchParams();
      f.state?.forEach((s) => p.append('state', s));
      if (f.q) p.set('q', f.q);
      if (f.page) p.set('page', String(f.page));
      return api.get<Paginated<Application>>(`/applications?${p}`);
    },
  });
export const useApplication = (id: string | null) =>
  useQuery({ queryKey: qk.application(id ?? ''), queryFn: () => api.get<Application>(`/applications/${id}`), enabled: !!id, refetchInterval: 4000 });
export const useJobs = (f: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: qk.jobs(f),
    queryFn: () => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
      return api.get<Paginated<Job>>(`/jobs?${p}`);
    },
    placeholderData: (prev) => prev,
  });
export const useJob = (id: string | null) => useQuery({ queryKey: qk.job(id ?? ''), queryFn: () => api.get<Job>(`/jobs/${id}`), enabled: !!id });
export const useDocuments = (kind?: 'resume' | 'cover_letter') => useQuery({ queryKey: qk.documents(kind), queryFn: () => api.get<Doc[]>(`/documents${kind ? `?kind=${kind}` : ''}`) });
export const useAnswers = () => useQuery({ queryKey: qk.answers, queryFn: () => api.get<SavedAnswer[]>('/answers') });
export const useCoverLetters = () => useQuery({ queryKey: qk.coverLetters, queryFn: () => api.get<CoverLetter[]>('/cover-letters') });
export const useNotifications = () => useQuery({ queryKey: qk.notifications, queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications'), refetchInterval: 30_000 });
export const useUsage = () => useQuery({ queryKey: qk.usage, queryFn: () => api.get<Usage>('/usage') });
export const useSources = () => useQuery({ queryKey: qk.sources, queryFn: () => api.get<Source[]>('/sources') });
export const useSavedSearches = () => useQuery({ queryKey: qk.savedSearches, queryFn: () => api.get<Array<{ id: string; name: string; query: Record<string, unknown> }>>('/saved-searches') });
export const useConnections = () =>
  useQuery({ queryKey: qk.connections, queryFn: () => api.get<Array<{ id: string; name: string; extensionVersion: string | null; createdAt: string; lastSeenAt: string | null; expiresAt: string; revokedAt: string | null }>>('/extension/connections'), refetchInterval: 10_000 });
export const usePlatforms = () => useQuery({ queryKey: qk.platforms, queryFn: () => api.get<Platform[]>('/public/platforms'), staleTime: 300_000 });

/** Mutation with toast feedback and cache invalidation. */
export function useAction<TVars, TOut = unknown>(fn: (v: TVars) => Promise<TOut>, opts: { success?: string | ((out: TOut) => string); invalidate?: QueryKey[]; onSuccess?: (out: TOut) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(out) : opts.success);
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      opts.onSuccess?.(out);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Supabase Realtime: live queue / notification updates (RLS limits the stream to the user's own rows). */
export function useRealtime() {
  const qc = useQueryClient();
  const { session } = useAuth();
  useEffect(() => {
    if (!session) return;
    const ch = supabase
      .channel(`af-${session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications', filter: `user_id=eq.${session.user.id}` }, () => {
        qc.invalidateQueries({ queryKey: ['applications'] });
        qc.invalidateQueries({ queryKey: ['application'] });
        qc.invalidateQueries({ queryKey: qk.dashboard });
        qc.invalidateQueries({ queryKey: qk.automation });
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${session.user.id}` }, (payload) => {
        qc.invalidateQueries({ queryKey: qk.notifications });
        const n = payload.new as Notification;
        if (n?.title) {
          const fn = n.severity === 'danger' ? toast.error : n.severity === 'warning' ? toast.warning : n.severity === 'success' ? toast.success : toast.info;
          fn(n.title, { description: n.body ?? undefined });
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [session, qc]);
}
