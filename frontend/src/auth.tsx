import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { request, ApiError } from './api/client';

export interface User {
  id: string;
  email: string;
  role: string;
  organizationId: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface AuthTokensResponse extends Tokens {
  user: User;
}

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, organizationName: string) => Promise<void>;
  logout: () => void;
  /** Authenticated fetch with automatic one-shot refresh on 401. */
  authedFetch: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE = 'codity.auth';

function load(): AuthTokensResponse | null {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as AuthTokensResponse) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initial = load();
  const [user, setUser] = useState<User | null>(initial?.user ?? null);
  // Tokens live in a ref so authedFetch never reads a stale closure after a refresh.
  const tokens = useRef<Tokens | null>(initial ? { accessToken: initial.accessToken, refreshToken: initial.refreshToken } : null);

  const persist = useCallback((res: AuthTokensResponse) => {
    tokens.current = { accessToken: res.accessToken, refreshToken: res.refreshToken };
    setUser(res.user);
    localStorage.setItem(STORAGE, JSON.stringify(res));
  }, []);

  const logout = useCallback(() => {
    tokens.current = null;
    setUser(null);
    localStorage.removeItem(STORAGE);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      persist(await request<AuthTokensResponse>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }));
    },
    [persist],
  );

  const signup = useCallback(
    async (email: string, password: string, organizationName: string) => {
      persist(
        await request<AuthTokensResponse>('/api/v1/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ email, password, organizationName }),
        }),
      );
    },
    [persist],
  );

  const authedFetch = useCallback(
    async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
      const current = tokens.current;
      try {
        return await request<T>(path, options, current?.accessToken);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && current?.refreshToken) {
          try {
            const refreshed = await request<AuthTokensResponse>('/api/v1/auth/refresh', {
              method: 'POST',
              body: JSON.stringify({ refreshToken: current.refreshToken }),
            });
            persist(refreshed);
            return await request<T>(path, options, refreshed.accessToken);
          } catch {
            logout();
          }
        }
        throw err;
      }
    },
    [persist, logout],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, isAuthenticated: !!user, login, signup, logout, authedFetch }),
    [user, login, signup, logout, authedFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
