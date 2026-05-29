import { FormEvent, useState } from 'react';
import { useAuth } from '../context/AuthContext';

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await login({ username, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-shell" aria-label="Multi Cloud Manager sign in">
        <aside className="login-brand-panel" aria-hidden="true">
          <div className="login-logo login-logo-large">
            <span>MC</span>
          </div>
          <div>
            <p className="login-eyebrow">Multi Cloud Manager</p>
            <h2 className="login-brand-title">Cloud and virtualization operations in one control plane.</h2>
          </div>
          <div className="login-metrics">
            <div>
              <span>OCI</span>
              <strong>Inventory</strong>
            </div>
            <div>
              <span>PVE</span>
              <strong>Operations</strong>
            </div>
            <div>
              <span>Audit</span>
              <strong>Tracked</strong>
            </div>
          </div>
        </aside>

        <section className="login-card">
          <div className="login-card-header">
            <div className="login-logo">
              <span>MC</span>
            </div>
            <div>
              <p className="login-eyebrow">Multi Cloud Manager</p>
              <h1>Sign in</h1>
            </div>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <label className="login-field">
              <span>Username</span>
              <input
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="login-field">
              <span>Password</span>
              <input
                autoComplete="current-password"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error ? <p className="login-error">{error}</p> : null}

            <button className="login-submit" disabled={submitting} type="submit">
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </section>
      </section>
    </main>
  );
}
