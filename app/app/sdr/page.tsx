import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { LeadsSemVendedor } from "./_components/LeadsSemVendedor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Leads sem vendedor" };

/**
 * Leads sem vendedor — a fila do SDR (docs/features/sdr.md). Quem pode ver e o
 * que aparece é decidido pelas rotas `/api/v1/sdr/*`; esta página só desenha.
 */
export default async function LeadsSemVendedorPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Leads sem vendedor")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Os negócios que estão com você ou ainda sem dono. Escolha o vendedor de cada um: o negócio, o cliente e as conversas abertas com você vão para ele.",
          )}
        </p>
      </header>
      <LeadsSemVendedor />
    </div>
  );
}
