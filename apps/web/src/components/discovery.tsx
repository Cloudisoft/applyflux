import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Radar, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { qk, useAction } from '@/lib/queries';
import { timeAgo } from '@/lib/utils';
import { Button, Card, Switch, buttonVariants } from '@/components/ui';

export interface DiscoveryStatus {
  running: boolean;
  autoDiscover: boolean;
  autoQueue: boolean;
  lastRunAt: string | null;
  intervalHours: number;
  last: { status: 'ok' | 'needs_titles' | 'failed'; titles: string[]; scanned: number; matched: number; added: number; queued: number; message?: string } | null;
}

export function useDiscovery() {
  return useQuery({
    queryKey: ['discovery'],
    queryFn: () => api.get<DiscoveryStatus>('/discovery'),
    // Poll while a search runs so results appear as soon as it finishes.
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
}

/** Automatic job search status: what ApplyFlux searches for, when it last ran, and a "Find jobs now" button. */
export function DiscoveryPanel({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const { data } = useDiscovery();
  const run = useAction(() => api.post('/discovery/run'), { invalidate: [['discovery']] });
  const settings = useAction((b: { autoDiscover?: boolean; autoQueue?: boolean }) => api.put('/discovery/settings', b), { invalidate: [['discovery']] });
  const kicked = React.useRef(false);
  const wasRunning = React.useRef(false);

  // First visit: start searching straight away instead of showing an empty page.
  React.useEffect(() => {
    if (data && !data.lastRunAt && !data.running && data.autoDiscover && !kicked.current) {
      kicked.current = true;
      run.mutate(undefined);
    }
  }, [data, run]);
  // When a search finishes, refresh the job list, queue and dashboard.
  React.useEffect(() => {
    if (wasRunning.current && data && !data.running) {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['applications'] });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    }
    wasRunning.current = !!data?.running;
  }, [data, qc]);

  if (!data) return null;
  const busy = data.running || run.isPending;
  const last = data.last;
  return (
    <Card className={compact ? 'p-4' : 'mb-4 p-4'}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-ink">{busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Radar className="h-5 w-5" />}</span>
        <div className="min-w-0 flex-1 text-sm">
          {busy ? (
            <div className="font-semibold">Searching company career sites and job boards for {last?.titles?.length ? last.titles.join(', ') : 'roles that fit you'}…</div>
          ) : last?.status === 'needs_titles' ? (
            <div className="font-semibold">Tell ApplyFlux which roles you want and it will find them for you.</div>
          ) : last?.status === 'ok' ? (
            <div className="font-semibold">
              Searched {timeAgo(data.lastRunAt)}: {last.added} new job{last.added === 1 ? '' : 's'} for {last.titles.join(', ')}
              {last.queued ? ` · ${last.queued} queued for Auto Apply` : ''}
            </div>
          ) : last?.status === 'failed' ? (
            <div className="font-semibold text-danger">The last search failed: {last.message}</div>
          ) : (
            <div className="font-semibold">ApplyFlux finds recent jobs for you automatically.</div>
          )}
          <div className="text-muted">
            {last?.status === 'needs_titles'
              ? 'Add your target job titles (or upload your resume) and the search starts by itself.'
              : `Recent postings (last 3 weeks) from 175+ company career sites and public job boards, matched to your titles and location. Repeats every ${data.intervalHours} hours.`}
          </div>
        </div>
        {last?.status === 'needs_titles' ? (
          <Link to="/app/profile" className={buttonVariants({ size: 'sm' })}>Add job titles</Link>
        ) : (
          <Button size="sm" loading={busy} onClick={() => run.mutate(undefined)}>
            <Search className="h-4 w-4" /> Find jobs now
          </Button>
        )}
      </div>
      {!compact && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-3 text-sm">
          <label className="flex items-center gap-2"><Switch checked={data.autoDiscover} onCheckedChange={(v) => settings.mutate({ autoDiscover: v })} label="Search automatically" /> Search automatically</label>
          <label className="flex items-center gap-2"><Switch checked={data.autoQueue} onCheckedChange={(v) => settings.mutate({ autoQueue: v })} label="Queue best matches for Auto Apply" /> Queue best matches for Auto Apply</label>
        </div>
      )}
    </Card>
  );
}
