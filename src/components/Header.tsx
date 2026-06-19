import { Link, useNavigate } from "@tanstack/react-router";
import { LineChart, LogOut, User } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export function Header() {
  const { user } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-20 max-w-[1400px] items-center justify-between gap-4 px-6 lg:px-10">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <img src="/logo-icon.png" alt="ValueScope" className="h-10 w-10" />
          <span className="text-xl">
            Value<span className="text-primary">Scope</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 text-sm sm:flex">
          <Link
            to="/watchlist"
            className="text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground font-medium" }}
          >
            Watchlist
          </Link>
          <Link
            to="/alertas"
            className="text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground font-medium" }}
          >
            Alertas de preços
          </Link>
        </nav>

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="hidden items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2.5 py-1 text-xs text-muted-foreground sm:inline-flex">
                <User className="h-3.5 w-3.5" />
                <span className="max-w-[160px] truncate">{user.email}</span>
              </span>
              <Button variant="ghost" size="default" onClick={handleLogout}>
                <LogOut className="mr-1 h-4 w-4" /> Sair
              </Button>
            </>
          ) : (
            <>
              <Button asChild variant="ghost" size="default">
                <Link to="/auth">Entrar</Link>
              </Button>
              <Button asChild size="default">
                <Link to="/auth" search={{ mode: "register" }}>
                  Registar
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
