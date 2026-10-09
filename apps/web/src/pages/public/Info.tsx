import { Check, Minus } from 'lucide-react';
import { Card, Badge, Skeleton } from '@/components/ui';
import { usePlatforms } from '@/lib/queries';

const STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' }> = {
  tested_sandbox: { label: 'End-to-end tested (ApplyFlux Sandbox)', tone: 'success' },
  tested_fixture: { label: 'Tested against representative form markup', tone: 'info' },
  manual_only: { label: 'Manual only', tone: 'warning' },
  untested: { label: 'Not yet tested', tone: 'neutral' },
};

export function Platforms() {
  const { data, isLoading } = usePlatforms();
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-ink">Compatibility</div>
      <h1 className="mt-3 text-4xl font-extrabold">Supported platforms</h1>
      <p className="mt-4 max-w-3xl text-muted">
        ApplyFlux does not claim universal automation. Each platform has a dedicated adapter, and its capabilities are listed here exactly as configured on this deployment. When a platform restricts automation, ApplyFlux offers a manual path rather than working around it.
      </p>
      <div className="mt-10 grid gap-4">
        {isLoading && <Skeleton className="h-64 rounded-3xl" />}
        {data?.map((p) => (
          <Card key={p.id} className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{p.name}</h2>
                <Badge tone={STATUS[p.testStatus]?.tone ?? 'neutral'} className="mt-1">
                  {STATUS[p.testStatus]?.label ?? p.testStatus}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                {[
                  ['Form filling', p.autofill],
                  ['Multi-step', p.multiStep],
                  ['Attachments', p.attachments],
                  ['Automatic submit', p.autoSubmit],
                ].map(([l, v]) => (
                  <span key={l as string} className="inline-flex items-center gap-1.5">
                    {v ? <Check className="h-4 w-4 text-success" /> : <Minus className="h-4 w-4 text-muted" />}
                    {l}
                  </span>
                ))}
              </div>
            </div>
            {p.restriction && <p className="mt-3 rounded-xl bg-warning/10 p-3 text-sm text-warning">{p.restriction}</p>}
          </Card>
        ))}
      </div>
      <p className="mt-8 text-sm text-muted">
        "Automatic submit" means Auto Mode may click the final submit button on that platform. Everywhere else ApplyFlux fills the form and you submit it. Sites may change their forms at any time; when ApplyFlux meets a form it doesn't recognise, it stops and asks you.
      </p>
    </main>
  );
}

export function Security() {
  const items = [
    ['Account security', 'Sign-in is handled by Supabase Auth with secure, refreshable sessions. ApplyFlux never stores your password.'],
    ['Data isolation', 'Every table is protected by PostgreSQL row-level security, and the API checks ownership on every request. Documents live in private storage under your account and are served only through short-lived, signed links.'],
    ['Server-side secrets', 'AI keys, database credentials and storage service keys stay on the server. The browser and the extension never receive them.'],
    ['Least-privilege extension', 'The ApplyFlux Agent starts with storage, alarms and scripting only. Access to job sites and notifications is optional and requested when you choose. It only opens and reads the application pages you queued — never your other tabs or browsing history. Its connection token is revocable at any time.'],
    ['No bypassing protections', 'ApplyFlux never solves or outsources CAPTCHAs, never evades bot protection, and never works around MFA or sign-in. It pauses and asks you.'],
    ['Truthful applications', 'Only facts you verified and answers you approved are submitted. Work authorisation, sponsorship, demographic, disability, veteran and criminal-history questions are never answered by AI.'],
    ['Untrusted web content', 'Job descriptions and page text are treated as data, never instructions. They cannot change what ApplyFlux does or access your information.'],
    ['Explicit consent', 'Auto Mode requires a recorded, versioned authorisation from you. You can withdraw it at any time.'],
    ['Audit trail', 'Significant automated actions — consent, submissions, extension pairing — are recorded. Each application has a full event timeline.'],
    ['Your control', 'Export all your data as JSON or permanently delete your account, documents and history from Account & Privacy.'],
  ];
  return (
    <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-ink">Trust</div>
      <h1 className="mt-3 text-4xl font-extrabold">Security & privacy</h1>
      <p className="mt-4 text-muted">How ApplyFlux protects your information and keeps your applications honest.</p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {items.map(([t, d]) => (
          <Card key={t} className="p-5">
            <h2 className="font-bold">{t}</h2>
            <p className="mt-2 text-sm text-muted">{d}</p>
          </Card>
        ))}
      </div>
    </main>
  );
}
