import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || '';

  // Redirect dashboard.stremboxd.com to /dashboard routes
  if (hostname === 'dashboard.stremboxd.com') {
    const path = request.nextUrl.pathname;

    // Root → /dashboard
    if (path === '/') {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }

    // /login → /dashboard/login
    if (path === '/login') {
      return NextResponse.redirect(new URL('/dashboard/login', request.url));
    }

    // Block access to non-dashboard routes on dashboard subdomain
    if (!path.startsWith('/dashboard')) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  // Block access to /dashboard on main domain (optional security)
  if (hostname === 'stremboxd.com' || hostname === 'www.stremboxd.com') {
    if (request.nextUrl.pathname.startsWith('/dashboard')) {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     * - public files (images, etc)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
