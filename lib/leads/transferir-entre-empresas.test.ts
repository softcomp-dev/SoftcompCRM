import { describe, expect, it } from "vitest";

import {
  ORIGEM_DO_CONTATO_TRANSFERIDO,
  contatoParaODestino,
  empresasDeDestino,
  montaPayloadDaTransferencia,
  recusaDaTransferencia,
  type VinculoDaPessoa,
} from "@/lib/leads/transferir-entre-empresas";
import type { EtapaDoFunil, OrigemParaClonar } from "@/lib/leads/clonar-para-funil";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const vinculos: VinculoDaPessoa[] = [
  { organization_id: A, nome: "Matriz", role: "manager" },
  { organization_id: B, nome: "Filial", role: "agent" },
  { organization_id: C, nome: "Só leitura", role: "viewer" },
];

describe("empresasDeDestino", () => {
  it("lista as outras empresas onde a pessoa pode criar negócio", () => {
    expect(empresasDeDestino(vinculos, A).map((v) => v.organization_id)).toEqual([B]);
  });

  it("nunca oferece a própria empresa de origem", () => {
    expect(empresasDeDestino(vinculos, B).map((v) => v.organization_id)).toEqual([A]);
  });

  it("vazio para quem tem uma empresa só", () => {
    expect(empresasDeDestino([vinculos[0]!], A)).toEqual([]);
  });
});

describe("recusaDaTransferencia", () => {
  const base = { origemOrgId: A, destinoOrgId: B, vinculos, statusDaOrigem: "open" };

  it("aceita gerente na origem e atendente no destino", () => {
    expect(recusaDaTransferencia(base)).toBeNull();
  });

  it("recusa transferir para a mesma empresa", () => {
    expect(recusaDaTransferencia({ ...base, destinoOrgId: A })?.code).toBe(
      "transfer_same_organization",
    );
  });

  it("recusa quem é só atendente na origem", () => {
    expect(recusaDaTransferencia({ ...base, origemOrgId: B, destinoOrgId: A })).toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("recusa empresa de destino em que a pessoa não tem vínculo", () => {
    expect(
      recusaDaTransferencia({ ...base, destinoOrgId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    ).toMatchObject({ code: "organization_not_found", status: 404 });
  });

  it("recusa destino em que a pessoa é só leitora", () => {
    expect(recusaDaTransferencia({ ...base, destinoOrgId: C })).toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("recusa negócio já encerrado", () => {
    expect(recusaDaTransferencia({ ...base, statusDaOrigem: "lost" })?.code).toBe("lead_not_open");
  });
});

describe("contatoParaODestino", () => {
  it("leva nome, telefone, e-mail e endereço, e marca de onde veio", () => {
    const ficha = contatoParaODestino(
      {
        id: "contato-1",
        name: "Maria",
        email: "maria@exemplo.invalid",
        phone_number: "+5511999998888",
        city: "Curitiba",
        state: "PR",
        street: "",
        contact_type: "cliente",
        tags: ["vip"],
      },
      A,
    );
    expect(ficha).toEqual({
      source: ORIGEM_DO_CONTATO_TRANSFERIDO,
      source_metadata: { transferido_de: { organization_id: A, contact_id: "contato-1" } },
      tags: ["vip"],
      name: "Maria",
      email: "maria@exemplo.invalid",
      phone_number: "+5511999998888",
      city: "Curitiba",
      state: "PR",
      contact_type: "cliente",
    });
  });

  it("não carrega CPF, consentimento nem campos personalizados do contato", () => {
    const ficha = contatoParaODestino(
      { id: "x", name: "João", ...({ cpf: "123", consent: { x: 1 }, custom_fields: { y: 1 } } as object) },
      A,
    );
    expect(ficha).not.toHaveProperty("cpf");
    expect(ficha).not.toHaveProperty("consent");
    expect(ficha).not.toHaveProperty("custom_fields");
  });
});

describe("montaPayloadDaTransferencia", () => {
  const origem: OrigemParaClonar = {
    id: "lead-1",
    pipeline_id: "funil-a",
    status: "open",
    title: "Pedido 42",
    contact_id: "contato-da-origem",
    value_cents: 15000,
    currency: "BRL",
    owner_user_id: "pessoa-1",
    owner_agent_id: "agente-da-origem",
    tags: ["quente"],
    source: "whatsapp",
    custom_fields: { produto: "X" },
    source_metadata: { utm: "abc", clonado_de: { lead_id: "antigo" } },
  };
  const etapa: EtapaDoFunil = {
    id: "etapa-b",
    pipeline_id: "funil-b",
    position: 1,
    is_won: false,
    is_lost: false,
  } as EtapaDoFunil;

  const payload = montaPayloadDaTransferencia(origem, etapa, "contato-do-destino", A);

  it("cria no funil e etapa do destino, com o contato do destino", () => {
    expect(payload.pipeline_id).toBe("funil-b");
    expect(payload.stage_id).toBe("etapa-b");
    expect(payload.contact_id).toBe("contato-do-destino");
  });

  it("leva o conteúdo do negócio", () => {
    expect(payload).toMatchObject({
      title: "Pedido 42",
      value_cents: 15000,
      tags: ["quente"],
      source: "whatsapp",
      custom_fields: { produto: "X" },
    });
  });

  it("leva o dono humano como herdado e deixa o agente de IA da origem", () => {
    expect(payload.owner_user_id).toBe("pessoa-1");
    expect(payload.dono_herdado).toBe(true);
    expect(payload).not.toHaveProperty("owner_agent_id");
  });

  it("aponta para a origem em outra empresa, sem ponteiro de mesma empresa", () => {
    expect(payload.source_metadata).toEqual({
      utm: "abc",
      transferido_de: { organization_id: A, lead_id: "lead-1", pipeline_id: "funil-a" },
    });
    expect(payload.retomado_de_lead_id).toBeNull();
  });
});
