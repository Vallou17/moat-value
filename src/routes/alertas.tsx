import { createFileRoute } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/alertas")({
  head: () => ({
    meta: [
      { title: "Alertas de Preços — ValueScope" },
      {
        name: "description",
        content: "Receba alertas quando ações atingirem o seu preço-alvo de compra ou venda.",
      },
      { property: "og:title", content: "Alertas de Preços — ValueScope" },
      {
        property: "og:description",
        content: "Receba alertas quando ações atingirem o seu preço-alvo de compra ou venda.",
      },
    ],
  }),
  component: AlertasPage,
});

function AlertasPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
          <Bell className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Alertas de Preços</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Receba notificações quando as suas ações atingirem preços-alvo.
        </p>
      </div>

      <Card className="p-8 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          Em breve
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Está a ser desenvolvido. Aqui poderá criar alertas de preço por ticker, definir limites
          superior e inferior, e ser notificado por email quando forem atingidos.
        </p>

        <div className="mt-8 rounded-lg border border-dashed border-border/60 p-6 text-left">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Os seus alertas
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">Ainda não tem alertas configurados.</p>
        </div>
      </Card>
    </div>
  );
}
