/**
 * Next.js 16 Proxy (the convention formerly named `middleware` — renamed in
 * v16, same functionality, now Node-runtime by default).
 *
 * Three gates, cheapest first:
 *
 * 1. Workbench gate — feature flag + runtime configuration.
 * 2. Admin gate — optimistic cookie-presence check only. The authoritative
 *    session validation lives in Node: `requireAdmin` for `/api/admin/*` and
 *    the dashboard layout's server-side check for `/admin/*` pages. Proxy
 *    answers the common unauthenticated case (redirect / 401) without paying
 *    for a database round-trip, and passes everything else through.
 * 3. Access-code gate — deployment-wide coarse lock. The admin console is
 *    exempt: it has its own stronger per-user authentication, and a shared
 *    access code must not be a second factor that also gates administrators.
 */
import { NextRequest, NextResponse } from 'next/server';

import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/session-cookie';
import { verifyAccessTokenEdge } from '@/lib/server/access-token-edge';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Return an actual server-side 404 when either half of the workbench is off.
  // Proxy cannot reliably inspect server-only deployment variables in its
  // edge configuration, so it enforces the public gate and leaves the
  // complete runtime/database check to Node.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  const isAdminApi = pathname.startsWith('/api/admin/');
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  const isLoginEndpoint = pathname === '/api/admin/auth/login';
  const isAdminLoginPage = pathname === '/admin/login';

  if (isAdminApi || isAdminPage) {
    const hasSessionCookie = !!request.cookies.get(ADMIN_SESSION_COOKIE)?.value;

    // API: everything except the login endpoint requires the cookie; the
    // authoritative check (and the real 401 for a stale token) happens in
    // `requireAdmin`.
    if (isAdminApi && !isLoginEndpoint && !hasSessionCookie) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '未登录' },
        { status: 401 },
      );
    }
    // Pages: without a cookie bounce straight to the login screen; with one,
    // the layout re-validates against the database server-side.
    if (isAdminPage && !isAdminLoginPage && !hasSessionCookie) {
      const loginUrl = new URL('/admin/login', request.url);
      if (pathname !== '/admin') loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  // Whitelist: access-code endpoints, health check, product login (must be
  // reachable to enter the code-locked site's credentials in the first place)
  if (
    pathname.startsWith('/api/access-code/') ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/health'
  ) {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyAccessTokenEdge(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
