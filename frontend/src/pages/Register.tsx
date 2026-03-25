import { Eye, EyeOff } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';

import { ChainlitContext, useAuth } from '@chainlit/react-client';

import Alert from '@/components/Alert';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/header/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FormValues {
  username: string;
  email?: string;
  password: string;
  confirmPassword: string;
  inviteCode?: string;
}

interface AuthStatus {
  has_users?: boolean;
  bootstrap_required?: boolean;
}

export default function Register() {
  const { data: config, user, setUserFromAPI } = useAuth();
  const apiClient = useContext(ChainlitContext);
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, touchedFields }
  } = useForm<FormValues>({
    defaultValues: {
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
      inviteCode: ''
    }
  });

  const password = watch('password');

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
    if (!config) {
      return;
    }
    if (user) {
      navigate('/');
      return;
    }
    if (config.headerAuth) {
      navigate('/login');
    }
  }, [config, user]);

  const onSubmit = async (data: FormValues) => {
    if (!config?.passwordAuth) {
      setError('当前未开启密码注册');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const username = data.username.trim();
      const payload = {
        username,
        password: data.password,
        email: data.email?.trim() || undefined,
        invite_code: data.inviteCode?.trim() || undefined
      };
      const res = await fetch(apiClient.buildEndpoint('/auth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success !== true) {
        throw new Error(json?.detail || '注册失败，请稍后重试');
      }

      const formData = new FormData();
      formData.append('username', username);
      formData.append('password', data.password);
      const loginJson = await apiClient.passwordAuth(formData);
      if (loginJson?.success != true) {
        throw new Error('注册成功但登录失败，请手动登录');
      }
      await setUserFromAPI();
      navigate('/');
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('注册失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-svh overflow-y-auto bg-gradient-to-b from-slate-100 via-white to-slate-50 font-acamind dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.2),_transparent_55%)] dark:bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.2),_transparent_55%)]" />

      <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
        <ThemeToggle className="rounded-full border border-border bg-background/85 shadow-sm backdrop-blur" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-svh w-full max-w-4xl items-center px-4 py-10 sm:px-6">
        <div className="w-full rounded-2xl border border-border/70 bg-background/95 p-6 shadow-xl sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Logo className="h-11 w-auto" />
              <div>
                <p className="text-lg font-semibold tracking-wide text-foreground">
                  Acamind · 知境
                </p>
                <p className="text-sm text-muted-foreground">创建新账户</p>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              已有账号？
              <Link
                to="/login"
                className="ml-2 text-foreground underline-offset-4 hover:underline"
              >
                去登录
              </Link>
            </div>
          </div>

          {error ? <Alert variant="error">{error}</Alert> : null}
          {authStatus?.bootstrap_required ? (
            <Alert variant="info">
              当前还没有任何账号。你注册的首个账户会自动成为管理员。
            </Alert>
          ) : null}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 grid gap-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  disabled={loading}
                  placeholder="请输入用户名"
                  autoComplete="username"
                  {...register('username', { required: '请输入用户名' })}
                  className={
                    touchedFields.username && errors.username
                      ? 'border-destructive'
                      : ''
                  }
                />
                {touchedFields.username && errors.username ? (
                  <p className="text-sm text-destructive">
                    {errors.username.message}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">邮箱（可选）</Label>
                <Input
                  id="email"
                  disabled={loading}
                  placeholder="me@example.com"
                  autoComplete="email"
                  {...register('email')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <div className="relative">
                  <Input
                    id="password"
                    disabled={loading}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="请输入密码"
                    autoComplete="new-password"
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
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">确认密码</Label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    disabled={loading}
                    type={showConfirm ? 'text' : 'password'}
                    placeholder="请再次输入密码"
                    autoComplete="new-password"
                    {...register('confirmPassword', {
                      required: '请再次输入密码',
                      validate: (value) =>
                        value === password || '两次输入的密码不一致'
                    })}
                    className={
                      touchedFields.confirmPassword && errors.confirmPassword
                        ? 'border-destructive'
                        : ''
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    onClick={() => setShowConfirm((prev) => !prev)}
                  >
                    {showConfirm ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {touchedFields.confirmPassword && errors.confirmPassword ? (
                  <p className="text-sm text-destructive">
                    {errors.confirmPassword.message}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="inviteCode">邀请码（可选）</Label>
                <Input
                  id="inviteCode"
                  disabled={loading}
                  placeholder="请输入邀请码"
                  {...register('inviteCode')}
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" className="w-full sm:w-48" disabled={loading}>
                {loading ? '注册中…' : '创建账户'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
