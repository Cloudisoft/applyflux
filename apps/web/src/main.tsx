import * as React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './index.css';
import { AuthProvider } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { TooltipProvider, buttonVariants } from '@/components/ui';
import { PublicLayout } from '@/layouts/PublicLayout';
import { AppLayout } from '@/layouts/AppLayout';
import { Landing } from '@/pages/public/Landing';
import { Platforms, Security } from '@/pages/public/Info';
import { ForgotPassword, ResetPassword, SignIn, SignUp } from '@/pages/auth/Auth';
import { DashboardPage } from '@/pages/app/Dashboard';
import { ControlCenter } from '@/pages/app/ControlCenter';
import { ApplicationsPage } from '@/pages/app/Applications';
import { JobDetail, JobDiscovery } from '@/pages/app/Jobs';
import { ProfilePage } from '@/pages/app/Profile';
import { ParseReview, ResumeLibrary } from '@/pages/app/Resumes';
import { CoverLetterStudio, ResumeStudio } from '@/pages/app/Studio';
import { AccountPage, AnswersPage, AutomationSettings, ExtensionPage, NotificationsPage } from '@/pages/app/Settings';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SetupWizard } from '@/pages/app/Setup';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
    },
  },
});

function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <div className="font-display text-6xl font-extrabold gradient-text">404</div>
        <p className="mt-2 text-muted">This page doesn't exist.</p>
        <Link to="/" className={`${buttonVariants({ variant: 'secondary' })} mt-6`}>Go home</Link>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <BrowserRouter>
            <ErrorBoundary>
            <Routes>
              <Route element={<PublicLayout />}>
                <Route index element={<Landing />} />
                <Route path="platforms" element={<Platforms />} />
                <Route path="security" element={<Security />} />
              </Route>
              <Route path="signin" element={<SignIn />} />
              <Route path="signup" element={<SignUp />} />
              <Route path="forgot-password" element={<ForgotPassword />} />
              <Route path="reset-password" element={<ResetPassword />} />
              <Route path="app" element={<AppLayout />}>
                <Route index element={<DashboardPage />} />
                <Route path="setup" element={<SetupWizard />} />
                <Route path="automation" element={<ControlCenter />} />
                <Route path="applications" element={<ApplicationsPage />} />
                <Route path="jobs" element={<JobDiscovery />} />
                <Route path="jobs/:id" element={<JobDetail />} />
                <Route path="match" element={<JobDiscovery matchMode />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="resumes" element={<ResumeLibrary />} />
                <Route path="resumes/review/:id" element={<ParseReview />} />
                <Route path="studio" element={<ResumeStudio />} />
                <Route path="cover-letters" element={<CoverLetterStudio />} />
                <Route path="answers" element={<AnswersPage />} />
                <Route path="extension" element={<ExtensionPage />} />
                <Route path="settings/automation" element={<AutomationSettings />} />
                <Route path="settings/account" element={<AccountPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
            </ErrorBoundary>
          </BrowserRouter>
          <Toaster richColors closeButton position="top-right" />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
