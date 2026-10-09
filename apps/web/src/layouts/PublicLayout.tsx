import { Link, NavLink, Outlet } from 'react-router-dom';
import { Logo, ThemeToggle } from '@/components/brand';
import { buttonVariants } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

export function PublicLayout() {
  const { session } = useAuth();
  return (
    <div className="min-h-screen bg-bg">
      <header className="glass sticky top-0 z-30 border-b border-line/70">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" aria-label="ApplyFlux home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-1 text-sm font-medium text-muted md:flex" aria-label="Site">
            {[
              ['/#how', 'How it works'],
              ['/#features', 'Features'],
              ['/platforms', 'Platforms'],
              ['/security', 'Security'],
              ['/#faq', 'FAQ'],
            ].map(([to, label]) => (
              <a key={to} href={to} className="rounded-lg px-3 py-2 transition hover:bg-elevated hover:text-ink">
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {session ? (
              <Link to="/app" className={buttonVariants({ size: 'sm' })}>
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to="/signin" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'hidden sm:inline-flex')}>
                  Sign in
                </Link>
                <Link to="/signup" className={buttonVariants({ size: 'sm' })}>
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <Outlet />
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4">
          <div className="md:col-span-2">
            <Logo />
            <p className="mt-4 max-w-sm text-sm text-muted">One profile. Every opportunity. Applications on autopilot — with a human in the loop whenever it matters.</p>
            <p className="mt-4 text-xs text-muted">ApplyFlux is a product of Cloudisoft. ApplyFlux is not affiliated with or endorsed by any job board or applicant-tracking system named on this site.</p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Product</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li><a href="/#features" className="hover:text-ink">Features</a></li>
              <li><NavLink to="/platforms" className="hover:text-ink">Supported platforms</NavLink></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Trust</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li><NavLink to="/security" className="hover:text-ink">Security & privacy</NavLink></li>
              <li><a href="/#faq" className="hover:text-ink">FAQ</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-line py-5 text-center text-xs text-muted">© {new Date().getFullYear()} Cloudisoft. All rights reserved.</div>
      </footer>
    </div>
  );
}
