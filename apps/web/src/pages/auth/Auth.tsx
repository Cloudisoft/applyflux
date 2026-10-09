import * as React from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { Logo } from '@/components/brand';
import { Button, Card, Field, Input } from '@/components/ui';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="relative grid min-h-screen place-items-center px-4 py-12">
      <div className="grid-bg absolute inset-0 -z-10 opacity-50 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      <div className="w-full max-w-md animate-fade-up">
        <Link to="/" className="mb-8 flex justify-center">
          <Logo />
        </Link>
        <Card className="p-7 sm:p-8">
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          {!supabaseConfigured && (
            <p className="mt-4 rounded-xl bg-warning/10 p-3 text-xs text-warning">Authentication isn't configured for this deployment. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</p>
          )}
          <div className="mt-6">{children}</div>
        </Card>
        {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}

const redirectTo = (path: string) => `${window.location.origin}${path}`;

export function SignIn() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const next = params.get('next') && params.get('next')!.startsWith('/app') ? params.get('next')! : '/app';
  if (session) return <Navigate to={next} replace />;
  return (
    <Shell title="Welcome back" subtitle="Sign in to continue your job search." footer={<>New to ApplyFlux? <Link to="/signup" className="font-semibold text-brand-ink hover:underline">Create an account</Link></>}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          setError(null);
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          setLoading(false);
          if (error) return setError(error.message === 'Email not confirmed' ? 'Please confirm your email first — check your inbox for the verification link.' : error.message);
          nav(next, { replace: true });
        }}
      >
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" badge={<Link to="/forgot-password" className="text-xs font-medium text-brand-ink hover:underline">Forgot password?</Link>}>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger" role="alert">{error}</p>}
        <Button type="submit" className="w-full" loading={loading}>
          Sign in
        </Button>
      </form>
    </Shell>
  );
}

export function SignUp() {
  const { session } = useAuth();
  const [form, setForm] = React.useState({ name: '', email: '', password: '' });
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  if (session) return <Navigate to="/app/setup" replace />;
  if (sent)
    return (
      <Shell title="Check your inbox" subtitle={<>We sent a verification link to <b>{form.email}</b>. Open it to activate your account.</>} footer={<Link to="/signin" className="font-semibold text-brand-ink hover:underline">Back to sign in</Link>}>
        <div className="flex justify-center">
          <MailCheck className="h-14 w-14 text-brand" />
        </div>
      </Shell>
    );
  const weak = form.password.length > 0 && form.password.length < 10;
  return (
    <Shell title="Create your account" subtitle="One profile for every application." footer={<>Already have an account? <Link to="/signin" className="font-semibold text-brand-ink hover:underline">Sign in</Link></>}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (form.password.length < 10) return setError('Use at least 10 characters for your password.');
          setLoading(true);
          setError(null);
          const { data, error } = await supabase.auth.signUp({
            email: form.email,
            password: form.password,
            options: { data: { full_name: form.name }, emailRedirectTo: redirectTo('/app/setup') },
          });
          setLoading(false);
          if (error) return setError(error.message);
          if (!data.session) setSent(true); // email confirmation required by project settings
        }}
      >
        <Field label="Full name" htmlFor="name">
          <Input id="name" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters." error={weak ? 'Too short' : null}>
          <Input id="password" type="password" autoComplete="new-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-invalid={weak} />
        </Field>
        {error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger" role="alert">{error}</p>}
        <Button type="submit" className="w-full" loading={loading}>
          Create account
        </Button>
        <p className="text-center text-xs text-muted">
          By creating an account you agree to how we handle data, described in <Link to="/security" className="underline">Security & privacy</Link>.
        </p>
      </form>
    </Shell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  return (
    <Shell title="Reset your password" subtitle="We'll email you a secure link." footer={<Link to="/signin" className="font-semibold text-brand-ink hover:underline">Back to sign in</Link>}>
      {sent ? (
        <div className="flex items-start gap-3 rounded-xl bg-success/10 p-4 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" /> If an account exists for {email}, a reset link is on its way.
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo('/reset-password') });
            setLoading(false);
            if (error) toast.error(error.message);
            else setSent(true);
          }}
        >
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" loading={loading}>
            Send reset link
          </Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const nav = useNavigate();
  const { session, loading: authLoading } = useAuth();
  const [password, setPassword] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  if (!authLoading && !session)
    return (
      <Shell title="Link expired" subtitle="This password reset link is invalid or has expired.">
        <Link to="/forgot-password" className="text-sm font-semibold text-brand-ink hover:underline">Request a new link</Link>
      </Shell>
    );
  return (
    <Shell title="Choose a new password">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password.length < 10) return toast.error('Use at least 10 characters.');
          setLoading(true);
          const { error } = await supabase.auth.updateUser({ password });
          setLoading(false);
          if (error) return toast.error(error.message);
          toast.success('Password updated');
          nav('/app');
        }}
      >
        <Field label="New password" htmlFor="password" hint="At least 10 characters.">
          <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={loading}>
          Update password
        </Button>
      </form>
    </Shell>
  );
}
