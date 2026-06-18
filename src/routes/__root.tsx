import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { Header } from "@/components/Header";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/integrations/supabase/client";

function NotFoundComponent() {
  return (
    <div className="grid min-h-[60vh] place-items-center px-4 text-center">
      <div>
        <h1 className="text-6xl font-bold">404</h1>
        <p className="mt-2 text-muted-foreground">Página não encontrada.</p>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="grid min-h-[60vh] place-items-center px-4 text-center">
      <div>
        <h1 className="text-xl font-semibold">Algo correu mal</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          onClick={() => {
            router.invalidate();
            reset();
          }}
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ValueScope — Análise de Valor Intrínseco" },
      {
        name: "description",
        content:
          "Calcule o valor intrínseco de ações através de DCF com pressupostos personalizáveis.",
      },
      { property: "og:title", content: "ValueScope — Análise de Valor Intrínseco" },
      { name: "twitter:title", content: "ValueScope — Análise de Valor Intrínseco" },
      { name: "description", content: "Moat Value é uma aplicação web que calcula o valor intrínseco de ações e analisa o seu fosso económico." },
      { property: "og:description", content: "Moat Value é uma aplicação web que calcula o valor intrínseco de ações e analisa o seu fosso económico." },
      { name: "twitter:description", content: "Moat Value é uma aplicação web que calcula o valor intrínseco de ações e analisa o seu fosso económico." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/114a1825-0ade-403a-af84-2dcc9d52f085/id-preview-7197c11a--b0543cfd-be4d-462a-9b11-952af8864cc7.lovable.app-1781779942275.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/114a1825-0ade-403a-af84-2dcc9d52f085/id-preview-7197c11a--b0543cfd-be4d-462a-9b11-952af8864cc7.lovable.app-1781779942275.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-PT">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen">
        <Header />
        <main>
          <Outlet />
        </main>
      </div>
      <Toaster richColors />
    </QueryClientProvider>
  );
}
