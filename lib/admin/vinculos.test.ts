import { describe, expect, it } from "vitest";
import {
  planejarVinculos,
  rebaixariaUltimoAdmin,
  vincularSchema,
  type VinculoExistente,
} from "./vinculos";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const FORA = "44444444-4444-4444-8444-444444444444";

const instalacao = new Set([A, B, C]);

describe("planejarVinculos", () => {
  it("cria onde não há vínculo, reativa o revogado e não mexe no ativo", () => {
    const existentes: VinculoExistente[] = [
      { id: "v-b", organization_id: B, role: "agent", revoked_at: "2026-01-01T00:00:00Z" },
      { id: "v-c", organization_id: C, role: "admin", revoked_at: null },
    ];
    expect(planejarVinculos([A, B, C], existentes, instalacao)).toEqual([
      { tipo: "criar", organizationId: A },
      { tipo: "reativar", organizationId: B, vinculoId: "v-b", papelAnterior: "agent" },
      { tipo: "ja_ativo", organizationId: C, papelAtual: "admin" },
    ]);
  });

  it("convite pendente (sem aceite) vira ACEITAR, não 'já ativo': senão a pessoa segue sem acesso", () => {
    const existentes: VinculoExistente[] = [
      { id: "v-a", organization_id: A, role: "admin", revoked_at: null, accepted_at: null },
      { id: "v-c", organization_id: C, role: "agent", revoked_at: null, accepted_at: "2026-01-01T00:00:00Z" },
    ];
    expect(planejarVinculos([A, C], existentes, instalacao)).toEqual([
      { tipo: "aceitar", organizationId: A, vinculoId: "v-a", papelAnterior: "admin" },
      { tipo: "ja_ativo", organizationId: C, papelAtual: "agent" },
    ]);
  });

  it("recusa empresa que não existe na instalação", () => {
    expect(planejarVinculos([FORA], [], instalacao)).toEqual([
      { tipo: "empresa_inexistente", organizationId: FORA },
    ]);
  });

  it("conta id repetido uma vez só", () => {
    expect(planejarVinculos([A, A], [], instalacao)).toHaveLength(1);
  });
});

describe("rebaixariaUltimoAdmin", () => {
  it("bloqueia rebaixar o único admin", () => {
    expect(rebaixariaUltimoAdmin("admin", "agent", 1)).toBe(true);
  });
  it("deixa rebaixar quando há outro admin", () => {
    expect(rebaixariaUltimoAdmin("admin", "agent", 2)).toBe(false);
  });
  it("promover nunca é rebaixar", () => {
    expect(rebaixariaUltimoAdmin("agent", "admin", 0)).toBe(false);
  });
});

describe("vincularSchema", () => {
  it("exige ao menos uma empresa e papel do vocabulário", () => {
    expect(vincularSchema.safeParse({ organization_ids: [], role: "agent" }).success).toBe(false);
    expect(vincularSchema.safeParse({ organization_ids: [A], role: "owner" }).success).toBe(false);
    expect(vincularSchema.safeParse({ organization_ids: [A], role: "manager" }).success).toBe(true);
  });
});
