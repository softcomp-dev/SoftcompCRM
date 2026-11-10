import type { Metadata } from "next";
import { Suspense } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ConsolidadoClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Visão consolidada" };

/**
 * VISÃO CONSOLIDADA — funil, conversas e contatos de várias empresas da pessoa
 * numa tela só, com filtro por empresa (uma, algumas ou todas).
 *
 * Quem decide as empresas é o servidor (`lib/consolidado/servidor.ts`): as da
 * pessoa, e nunca outra. A tela só escolhe dentre elas. A empresa ATIVA da
 * sessão desce como prop porque abrir um card, uma conversa ou um contato de
 * outra empresa troca a empresa ativa antes — o resto do app continua
 * operando uma empresa por vez.
 */
export default async function ConsolidadoPage() {
  const user = await requireAuth();
  const ativa = await resolveActiveOrg(user);
  return (
    <Suspense>
      <ConsolidadoClient empresaAtiva={ativa?.orgId ?? null} emSuporte={!!user.support} />
    </Suspense>
  );
}
