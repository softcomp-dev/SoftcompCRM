/**
 * A lista "Leads sem vendedor" mostra exatamente o que a passagem aceita
 * (`recusaDoNegocio`): negócio aberto com o SDR ou sem dono humano.
 */
import { describe, expect, it } from "vitest";

import { montarNegociosDoSdr, situacaoDoNegocio, type LinhaDoNegocio } from "./negocios-do-sdr";

const SDR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLEGA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENTE = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const linha = (id: string, extra: Partial<LinhaDoNegocio> = {}): LinhaDoNegocio => ({
  id,
  title: `Negócio ${id}`,
  status: "open",
  value_cents: 1000,
  currency: "BRL",
  created_at: "2026-11-10T10:00:00.000Z",
  last_activity_at: null,
  pipeline_id: "funil",
  stage_id: "etapa",
  contact_id: "contato",
  owner_user_id: null,
  owner_kind: null,
  owner_agent_id: null,
  ...extra,
});

const nomes = {
  funis: new Map([["funil", "Vendas"]]),
  etapas: new Map([["etapa", "Qualificação"]]),
  contatos: new Map([["contato", "Maria"]]),
  agentes: new Map([[AGENTE, "Sofia"]]),
};

describe("situacaoDoNegocio", () => {
  it("diz com quem o negócio está", () => {
    expect(situacaoDoNegocio({ owner_user_id: SDR, owner_kind: "user", owner_agent_id: null }, SDR)).toBe("comigo");
    expect(situacaoDoNegocio({ owner_user_id: null, owner_kind: "ai", owner_agent_id: AGENTE }, SDR)).toBe("ia");
    expect(situacaoDoNegocio({ owner_user_id: null, owner_kind: null, owner_agent_id: null }, SDR)).toBe("fila");
  });
});

describe("montarNegociosDoSdr", () => {
  it("mantém só o que a passagem aceita e fora de funil arquivado", () => {
    const lista = montarNegociosDoSdr(
      [
        linha("comigo", { owner_user_id: SDR, owner_kind: "user" }),
        linha("fila"),
        linha("ia", { owner_kind: "ai", owner_agent_id: AGENTE }),
        linha("do-colega", { owner_user_id: COLEGA, owner_kind: "user" }),
        linha("ganho", { status: "won" }),
        linha("arquivado", { pipeline_id: "velho" }),
      ],
      SDR,
      nomes,
      new Set(["velho"]),
    );
    expect(lista.map((n) => n.id).sort()).toEqual(["comigo", "fila", "ia"]);
  });

  it("preenche os nomes e a situação de cada um", () => {
    const [n] = montarNegociosDoSdr([linha("ia", { owner_kind: "ai", owner_agent_id: AGENTE })], SDR, nomes);
    expect(n).toMatchObject({
      pipeline_name: "Vendas",
      stage_name: "Qualificação",
      contact_name: "Maria",
      situacao: "ia",
      owner_agent_name: "Sofia",
    });
  });

  it("ordena do mais antigo para o mais novo", () => {
    const lista = montarNegociosDoSdr(
      [
        linha("novo", { created_at: "2026-11-10T12:00:00.000Z" }),
        linha("velho", { created_at: "2026-11-09T12:00:00.000Z" }),
      ],
      SDR,
      nomes,
    );
    expect(lista.map((n) => n.id)).toEqual(["velho", "novo"]);
  });

  it("negócio sem contato não quebra", () => {
    const [n] = montarNegociosDoSdr([linha("sem", { contact_id: null })], SDR, nomes);
    expect(n?.contact_name).toBeNull();
  });
});
