'use client';

/**
 * The product-user login form, shared by the login modal
 * (components/login-modal.tsx) and the /login deep-link page
 * (app/login/page.tsx). No registration: accounts are created in the admin
 * console and distributed (本产品不开通自助注册). On success it fires
 * `openmaic:auth-changed` — the event the header, the account-profile sync,
 * and every gated page listen on — and hands navigation to the caller.
 */
import { useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';

interface LoginFormProps {
  /** Called after a successful login and the auth-changed dispatch. */
  onSuccess: () => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || t('login.failed'));
        return;
      }
      window.dispatchEvent(new Event('openmaic:auth-changed'));
      onSuccess();
    } catch {
      setError(t('login.networkError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-username">{t('login.username')}</Label>
        <Input
          id="login-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-password">{t('login.password')}</Label>
        <Input
          id="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
        {t('login.submit')}
      </Button>
      <p className="text-muted-foreground text-center text-xs">{t('login.hint')}</p>
    </form>
  );
}
