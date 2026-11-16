/**
 * O PÚBLICO DA CAMPANHA POR CLASSIFICAÇÃO (migration 9257).
 *
 * A prévia lê os prazos da ORGANIZAÇÃO e manda à consulta de contatos o mesmo
 * `or` sobre `last_won_at` que a lista de contatos usa. O PostgREST é falso só
 * na rede: o cliente supabase-js é o de verdade, e o que se mede é a URL.
 */
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { cortesDaClassificacao } from "@/lib/clientes/classificacao";

import { FILTRO_VAZIO, filtroDeAudienciaSchema } from "./audiencia";
import { buscarCandidatos } from "./consulta-de-audiencia";

const ORG = "99999999-9999-4999-8999-999999999999";
const AGORA = new Date(Date.UTC(2026, 5, 1));

function banco() {
  const urls: string[] = [];
  const sb = createClient("http://127.0.0.1:54321", "x".repeat(200), {
    global: {
      fetch: async (entrada: RequestInfo | URL) => {
        const url = String(entrada);
        urls.push(url);
        const corpo = url.includes("/organizations")
          ? { classificacao_ativo_dias: 30, classificacao_pre_inativo_dias: 60 }
          : [];
        return new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  return { sb, urls };
}

describe("público por classificação", () => {
  it("a consulta de contatos leva a faixa com os prazos da organização", async () => {
    const { sb, urls } = banco();
    await buscarCandidatos(sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, classificacoes: ["pre_inativo"] },
      agora: AGORA,
    });
    const { ativoDesde, preInativoDesde } = cortesDaClassificacao({ ativoDias: 30, preInativoDias: 60 }, AGORA);
    const contatos = urls.filter((u) => u.includes("/contacts"));
    expect(contatos.length).toBeGreaterThan(0);
    const ors = new URL(contatos[0]!).searchParams.getAll("or");
    expect(ors).toContain(`(and(last_won_at.gte.${preInativoDesde},last_won_at.lt.${ativoDesde}))`);
    for (const u of urls) expect(u).toContain(ORG);
  });

  it("sem classificação, nem lê os prazos nem filtra por last_won_at", async () => {
    const { sb, urls } = banco();
    await buscarCandidatos(sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"] },
      agora: AGORA,
    });
    expect(urls.some((u) => u.includes("/organizations"))).toBe(false);
    expect(urls.some((u) => u.includes("last_won_at"))).toBe(false);
  });

  it("a classificação sozinha é critério suficiente; valor inventado é recusado", () => {
    expect(filtroDeAudienciaSchema.safeParse({ classificacoes: ["pre_inativo"] }).success).toBe(true);
    expect(filtroDeAudienciaSchema.safeParse({ classificacoes: ["vip"] }).success).toBe(false);
  });
});
