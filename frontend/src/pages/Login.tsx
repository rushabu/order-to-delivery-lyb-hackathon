import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Eye, EyeSlash } from "@phosphor-icons/react";
import { api, ApiError } from "../api/client";
import type { LoginResponse, Role } from "../api/contract";
import { homeFor, setSession, useSession } from "../auth/session";
import { FICTIONAL_NOTICE, Mark, ThemeToggle } from "../components/AppShell";

/*
  Sign in. Left: the ordinary email and password form. Right, only when the API runs in demo mode:
  a roster of the seeded fictional accounts, one tap each, so a presenter can switch roles quickly.
  The roster comes from GET /auth/demo-accounts, which does not exist outside demo mode.
*/

interface DemoAccount {
  id: string;
  name: string;
  role: Role;
  org: string;
}

const GROUPS: { role: Role; title: string; note: string }[] = [
  { role: "COORDINATOR", title: "Coordinators", note: "Logistics supervisors at Plant X" },
  { role: "DRIVER", title: "Drivers", note: "Phone layout" },
  { role: "CUSTOMER", title: "Customers", note: "Their own orders only" },
];

function messageFor(err: unknown): string {
  const status = err instanceof ApiError ? err.status : -1;
  if (status === 401) return "That email and password do not match an account. Check both and try again.";
  if (status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (status === 0) return "The server could not be reached. Check that the API is running, then try again.";
  return "Sign-in failed. Try again.";
}

export function Login() {
  const session = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const demo = useQuery({
    queryKey: ["demo-accounts"],
    queryFn: ({ signal }) => api<DemoAccount[]>("/auth/demo-accounts", { signal }),
    retry: false,
    staleTime: Infinity,
    refetchInterval: false,
  });

  if (session) return <Navigate to={homeFor(session.user.role)} replace />;

  async function finish(key: string, call: () => Promise<LoginResponse>) {
    setBusy(key);
    setError(null);
    try {
      const res = await call();
      setSession({ token: res.token, user: res.user });
      navigate(homeFor(res.user.role), { replace: true });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(null);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void finish("form", () => api<LoginResponse>("/auth/login", { method: "POST", body: { email, password } }));
  };
  const quick = (a: DemoAccount) => void finish(a.id, () => api<LoginResponse>("/auth/demo-login", { method: "POST", body: { user_id: a.id } }));

  const accounts = demo.data ?? [];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center gap-3 px-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5 rounded-sm font-semibold">
            <Mark />
            <span className="wide hidden text-body tracking-tight min-[400px]:inline">Plant X Control Tower</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <Link to="/" className="hidden items-center gap-1.5 rounded-md px-3 py-2 text-body text-ink-2 transition-colors hover:text-ink sm:inline-flex">
              <ArrowLeft size={14} weight="bold" aria-hidden /> Overview
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main id="main" className={`mx-auto grid w-full max-w-[1180px] flex-1 grid-cols-1 gap-x-20 gap-y-12 px-5 py-10 sm:px-8 lg:py-16 ${accounts.length ? "lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]" : "max-w-[520px]"}`}>
        {/* Form */}
        <section aria-labelledby="signin-h" className="min-w-0">
          <h1 id="signin-h" className="wide text-[2.4rem] font-[800] leading-[1.05] tracking-[-0.035em]">
            Sign in
          </h1>
          <p className="mt-3 max-w-[36ch] text-body text-muted">Your account decides what you see: the control tower, your trip, or your orders.</p>

          <form onSubmit={onSubmit} className="mt-10 space-y-7" noValidate>
            <Field label="Email" htmlFor="email">
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.example"
                className="ct-underline-input"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <div className="relative">
                <input
                  id="password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="ct-underline-input pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? "Hide password" : "Show password"}
                  aria-pressed={show}
                  className="absolute bottom-1 right-0 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:text-ink"
                >
                  {show ? <EyeSlash size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                </button>
              </div>
            </Field>

            {error && (
              <p role="alert" className="border-l-4 border-high bg-high-soft px-3 py-2.5 text-body text-high">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!!busy || !email || !password}
              className="group flex h-13 w-full items-center justify-between rounded-md bg-ink px-5 text-lead font-semibold text-canvas transition-colors duration-150 hover:bg-ink-2 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted"
            >
              {busy === "form" ? "Signing in…" : "Sign in"}
              <ArrowRight size={18} weight="bold" aria-hidden className="transition-transform duration-200 group-enabled:group-hover:translate-x-1" />
            </button>
          </form>
        </section>

        {/* Demo roster */}
        {accounts.length > 0 && (
          <section aria-labelledby="quick-h" className="min-w-0 lg:border-l lg:border-line lg:pl-20">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="quick-h" className="text-heading font-semibold">
                Quick sign-in
              </h2>
              <p className="text-meta text-muted">Demo mode. Fictional accounts, no password.</p>
            </div>

            <div className="mt-6 space-y-8">
              {GROUPS.map((g) => {
                const rows = accounts.filter((a) => a.role === g.role);
                if (!rows.length) return null;
                return (
                  <div key={g.role}>
                    <div className="flex items-baseline justify-between gap-3 border-b-2 border-ink pb-1.5">
                      <h3 className="text-body font-semibold">{g.title}</h3>
                      <span className="text-meta text-muted">{g.note}</span>
                    </div>
                    <ul>
                      {rows.map((a) => (
                        <li key={a.id} className="border-b border-line">
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() => quick(a)}
                            className="ct-roster-row group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-2 py-3 text-left disabled:cursor-wait"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-body font-semibold text-ink">{a.name}</span>
                              <span className="block truncate text-meta text-muted group-hover:text-ink-2">{a.org}</span>
                            </span>
                            <span className="ct-roster-go inline-flex items-center gap-1.5 text-meta font-semibold text-ink">
                              {busy === a.id ? "Signing in…" : "Sign in"}
                              <ArrowRight size={14} weight="bold" aria-hidden />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>

      {/* A stretch of road along the foot of the page */}
      <div aria-hidden className="relative h-10 bg-road">
        <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-[repeating-linear-gradient(to_right,#ffffff_0_28px,transparent_28px_52px)] opacity-60" />
        <span className="absolute inset-x-0 top-1 h-[2px] bg-accent" />
        <span className="absolute inset-x-0 bottom-1 h-[2px] bg-accent" />
      </div>
      <footer className="bg-road">
        <p className="mx-auto max-w-[1180px] px-5 pb-4 text-meta text-rail-muted sm:px-8">{FICTIONAL_NOTICE}</p>
      </footer>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-meta font-semibold text-ink-2">
        {label}
      </label>
      {children}
    </div>
  );
}
