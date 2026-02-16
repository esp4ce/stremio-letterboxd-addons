const TOKEN_KEY = 'dashboard_token';

export function storeToken(token: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

export function getToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem(TOKEN_KEY);
  }
  return null;
}

export function clearToken(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) {
    throw new Error('No authentication token found');
  }

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

export function isTokenExpired(token: string): boolean {
  try {
    // Decode JWT payload (base64url)
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    const exp = payload.exp;

    if (!exp) return false;

    // Check if expired (with 5 minute buffer)
    return Date.now() >= exp * 1000 - 5 * 60 * 1000;
  } catch {
    return true;
  }
}
