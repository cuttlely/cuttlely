import { lazy } from 'react'

import Loadable from '@/ui-component/loading/Loadable'
import AuthLayout from '@/layout/AuthLayout'
import { RequireAuth } from '@/routes/RequireAuth'
import { GITHUB_STEP_PATH } from '@/utils/firstRun'

const ResolveLoginPage = Loadable(lazy(() => import('@/views/auth/login')))
const SignInPage = Loadable(lazy(() => import('@/views/auth/signIn')))
const RegisterPage = Loadable(lazy(() => import('@/views/auth/register')))
const VerifyEmailPage = Loadable(lazy(() => import('@/views/auth/verify-email')))
const ConfirmEmailChangePage = Loadable(lazy(() => import('@/views/auth/confirm-email-change')))
const ForgotPasswordPage = Loadable(lazy(() => import('@/views/auth/forgotPassword')))
const ResetPasswordPage = Loadable(lazy(() => import('@/views/auth/resetPassword')))
const LocalAcceptPage = Loadable(lazy(() => import('@/views/auth/localAccept')))
const UnauthorizedPage = Loadable(lazy(() => import('@/views/auth/unauthorized')))
const RateLimitedPage = Loadable(lazy(() => import('@/views/auth/rateLimited')))
const OrganizationSetupPage = Loadable(lazy(() => import('@/views/organization/index')))
const LicenseExpiredPage = Loadable(lazy(() => import('@/views/auth/expired')))
const GithubStepPage = Loadable(lazy(() => import('@/views/setup/GithubStep')))
const ServerSetupPage = Loadable(lazy(() => import('@/views/serversetup')))

const AuthRoutes = {
    path: '/',
    element: <AuthLayout />,
    children: [
        {
            path: '/login',
            element: <ResolveLoginPage />
        },
        {
            path: '/signin',
            element: <SignInPage />
        },
        {
            path: '/register',
            element: <RegisterPage />
        },
        {
            path: '/verify',
            element: <VerifyEmailPage />
        },
        {
            path: '/confirm-email-change',
            element: <ConfirmEmailChangePage />
        },
        {
            path: '/forgot-password',
            element: <ForgotPasswordPage />
        },
        {
            path: '/reset-password',
            element: <ResetPasswordPage />
        },
        {
            path: '/local-accept',
            element: <LocalAcceptPage />
        },
        {
            path: '/unauthorized',
            element: <UnauthorizedPage />
        },
        {
            path: '/rate-limited',
            element: <RateLimitedPage />
        },
        {
            path: '/organization-setup',
            element: <OrganizationSetupPage />
        },
        {
            // The one-time setup link from the server log, when nobody can sign in yet.
            path: '/server-setup',
            element: <ServerSetupPage />
        },
        {
            path: '/license-expired',
            element: <LicenseExpiredPage />
        },
        {
            // First-run setup, optional GitHub step. Signed in; the GitHub routes themselves are owner-only.
            path: GITHUB_STEP_PATH,
            element: (
                <RequireAuth>
                    <GithubStepPage />
                </RequireAuth>
            )
        }
    ]
}

export default AuthRoutes
