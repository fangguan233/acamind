import { Eye, EyeOff } from 'lucide-react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';

import Alert from '@/components/Alert';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/header/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useQuery } from 'hooks/query';

import { ChainlitContext, useAuth } from 'client-types/*';

export const LoginError = new Error(
  'Error logging in. Please try again later.'
);

interface FormValues {
  identifier: string;
  password: string;
}

interface AuthStatus {
  has_users?: boolean;
  bootstrap_required?: boolean;
}

export default function Login() {
  const query = useQuery();
  const { data: config, user, setUserFromAPI } = useAuth();
  const apiClient = useContext(ChainlitContext);
  const navigate = useNavigate();

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, touchedFields }
  } = useForm<FormValues>({
    defaultValues: {
      identifier: '',
      password: ''
    }
  });

  const hasPasswordAuth = !!config?.passwordAuth;
  const oauthProviders = useMemo(() => config?.oauthProviders || [], [config]);
  const hasOauth = oauthProviders.length > 0;

  const handleCookieAuth = (json: any): void => {
    if (json?.success != true) throw LoginError;
    setUserFromAPI();
  };

  const handleAuth = async (
    jsonPromise: Promise<any>,
    redirectURL?: string
  ) => {
    try {
      const json = await jsonPromise;
      handleCookieAuth(json);
      if (redirectURL) {
        navigate(redirectURL);
      }
    } catch (error: any) {
      setError(error.message || '登录失败');
    }
  };

  const handleHeaderAuth = async () => {
    const jsonPromise = apiClient.headerAuth();
    await handleAuth(jsonPromise, '/');
  };

  const handlePasswordLogin = async (identifier: string, password: string) => {
    const formData = new FormData();
    formData.append('username', identifier);
    formData.append('password', password);
    const jsonPromise = apiClient.passwordAuth(formData);
    await handleAuth(jsonPromise);
  };

  useEffect(() => {
    let cancelled = false;
    const loadAuthStatus = async () => {
      try {
        const res = await fetch(apiClient.buildEndpoint('/auth/status'), {
          credentials: 'include'
        });
        if (!res.ok) return;
        const json = (await res.json()) as AuthStatus;
        if (!cancelled) {
          setAuthStatus(json);
        }
      } catch {
        if (!cancelled) {
          setAuthStatus(null);
        }
      }
    };
    void loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  useEffect(() => {
    setError(query.get('error') || '');
  }, [query]);

  useEffect(() => {
    if (!config) {
      return;
    }
    if (config.headerAuth && !user) {
      handleHeaderAuth();
    }
    if (user) {
      navigate('/');
    }
  }, [config, user]);

  const onSubmit = async (data: FormValues) => {
    if (!hasPasswordAuth) {
      setError('当前未开启密码登录');
      return;
    }
    if (authStatus?.bootstrap_required) {
      setError('当前还没有任何账号，请先注册首个管理员账户。');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await handlePasswordLogin(data.identifier.trim(), data.password);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-svh overflow-y-auto bg-gradient-to-b from-slate-100 via-white to-slate-50 font-acamind dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.2),_transparent_55%)] dark:bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.2),_transparent_55%)]" />

      <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
        <ThemeToggle className="rounded-full border border-border bg-background/85 shadow-sm backdrop-blur" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-svh w-full max-w-lg items-center px-4 py-8 sm:px-6">
        <div className="w-full rounded-2xl border border-border/70 bg-background/95 p-7 shadow-xl sm:p-9">
          <div className="mb-8 flex items-start gap-4">
            <Logo className="h-14 w-auto shrink-0 sm:h-16" />
            <div className="pt-1">
              <p className="text-xl font-semibold tracking-wide text-foreground sm:text-2xl">
                Acamind · 知境
              </p>
              <p className="mt-1 text-sm text-muted-foreground">登录你的账户</p>
            </div>
          </div>

          {error ? <Alert variant="error">{error}</Alert> : null}
          {authStatus?.bootstrap_required ? (
            <Alert variant="info">
              当前认证库没有任何账号。请先注册首个账户，系统会自动将它设为管理员。
            </Alert>
          ) : null}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="identifier">用户名或邮箱</Label>
              <Input
                id="identifier"
                disabled={loading}
                placeholder="输入用户名或邮箱"
                autoComplete="username"
                {...register('identifier', { required: '请输入用户名或邮箱' })}
                className={
                  touchedFields.identifier && errors.identifier
                    ? 'border-destructive'
                    : ''
                }
              />
              {touchedFields.identifier && errors.identifier ? (
                <p className="text-sm text-destructive">
                  {errors.identifier.message}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <div className="relative">
                <Input
                  id="password"
                  disabled={loading}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="输入密码"
                  autoComplete="current-password"
                  {...register('password', { required: '请输入密码' })}
                  className={
                    touchedFields.password && errors.password
                      ? 'border-destructive'
                      : ''
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {touchedFields.password && errors.password ? (
                <p className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              ) : null}
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? '登录中…'
                : authStatus?.bootstrap_required
                  ? '请先注册管理员'
                  : '登录'}
            </Button>
          </form>

          {hasOauth ? (
            <div className="mt-6">
              <div className="relative text-center text-xs uppercase tracking-[0.2em] text-muted-foreground">
                <span className="relative z-10 bg-background px-2">或</span>
                <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-border" />
              </div>
              <div className="mt-4 grid gap-2">
                {oauthProviders.map((provider, index) => (
                  <Button
                    key={`provider-${index}`}
                    variant="outline"
                    onClick={() => {
                      window.location.href = apiClient.getOAuthEndpoint(provider);
                    }}
                  >
                    使用 {provider} 继续
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {authStatus?.bootstrap_required ? '系统尚未初始化？' : '还没有账号？'}
            </span>
            <Link
              to="/register"
              className="text-foreground underline-offset-4 hover:underline"
            >
              {authStatus?.bootstrap_required ? '初始化管理员' : '去注册'}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
