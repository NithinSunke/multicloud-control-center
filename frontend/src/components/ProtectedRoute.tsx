import { LoginPage } from '../pages/LoginPage';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { loading, user } = useAuth();

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-100 text-slate-700">
        Loading workspace...
      </main>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return children;
}
