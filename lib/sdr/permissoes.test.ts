import { describe, expect, it } from "vitest";

import { comConfiguracaoSdr, lerConfiguracaoSdr } from "./configuracao";
import {
  PAPEIS_QUE_PODEM_SER_SDR,
  permissoesDoMembro,
  type MembroParaPermissao,
} from "./permissoes";

const SDR_AGENT: MembroParaPermissao = {
  user_id: "u1",
  role: "agent",
  revoked_at: null,
  sdr_since: "2026-11-10T12:00:00.000Z",
};

describe("lerConfiguracaoSdr", () => {
  it("nasce desligada quando a organização nunca tocou na chave", () => {
    expect(lerConfiguracaoSdr(null)).toEqual({ enabled: false });
    expect(lerConfiguracaoSdr({})).toEqual({ enabled: false });
    expect(lerConfiguracaoSdr({ outra: 1 })).toEqual({ enabled: false });
  });

  it("valor torto vira desligada, nunca lança", () => {
    expect(lerConfiguracaoSdr({ sdr: "sim" })).toEqual({ enabled: false });
    expect(lerConfiguracaoSdr({ sdr: { enabled: "true" } })).toEqual({ enabled: false });
    expect(lerConfiguracaoSdr({ sdr: [] })).toEqual({ enabled: false });
    expect(lerConfiguracaoSdr("lixo")).toEqual({ enabled: false });
  });

  it("lê ligada", () => {
    expect(lerConfiguracaoSdr({ sdr: { enabled: true } })).toEqual({ enabled: true });
  });
});

describe("comConfiguracaoSdr", () => {
  it("muda só settings.sdr.enabled e preserva o resto", () => {
    const antes = { catalogo: { apresentacao: true }, sdr: { enabled: false, futura: 7 } };
    expect(comConfiguracaoSdr(antes, { enabled: true })).toEqual({
      catalogo: { apresentacao: true },
      sdr: { enabled: true, futura: 7 },
    });
    // não muta a entrada
    expect(antes.sdr.enabled).toBe(false);
  });

  it("aceita settings nulo", () => {
    expect(comConfiguracaoSdr(null, { enabled: true })).toEqual({ sdr: { enabled: true } });
  });
});

describe("PAPEIS_QUE_PODEM_SER_SDR", () => {
  it("é agent para cima, derivado da escada", () => {
    expect(PAPEIS_QUE_PODEM_SER_SDR).toEqual(["agent", "manager", "admin"]);
  });
});

describe("permissoesDoMembro", () => {
  it("SDR ativo recebe as permissões de trabalho do lead", () => {
    const p = permissoesDoMembro(SDR_AGENT, true);
    expect(p.sdr).toEqual({
      feature_enabled: true,
      assigned: true,
      assigned_since: SDR_AGENT.sdr_since,
      active: true,
      inactive_reason: null,
    });
    expect(p.permissions).toEqual(["sdr.leads.prospect", "sdr.leads.qualify", "sdr.leads.handoff"]);
  });

  it("função desligada: a marca fica, as permissões somem", () => {
    const p = permissoesDoMembro(SDR_AGENT, false);
    expect(p.sdr.assigned).toBe(true);
    expect(p.sdr.active).toBe(false);
    expect(p.sdr.inactive_reason).toBe("feature_disabled");
    expect(p.permissions).toEqual([]);
  });

  it("rebaixado para viewer: a marca fica sem efeito", () => {
    const p = permissoesDoMembro({ ...SDR_AGENT, role: "viewer" }, true);
    expect(p.sdr.inactive_reason).toBe("role_below_minimum");
    expect(p.permissions).toEqual([]);
  });

  it("vínculo revogado: nada, nem as de admin", () => {
    const p = permissoesDoMembro({ ...SDR_AGENT, role: "admin", revoked_at: "2026-11-01T00:00:00Z" }, true);
    expect(p.membership_active).toBe(false);
    expect(p.sdr.inactive_reason).toBe("membership_revoked");
    expect(p.permissions).toEqual([]);
  });

  it("não marcado: sem permissões de SDR", () => {
    const p = permissoesDoMembro({ ...SDR_AGENT, sdr_since: null }, true);
    expect(p.sdr.inactive_reason).toBe("not_assigned");
    expect(p.permissions).toEqual([]);
  });

  it("admin liga a função mesmo com ela desligada, mas só gerencia a equipe com ela ligada", () => {
    const admin = { ...SDR_AGENT, role: "admin", sdr_since: null };
    expect(permissoesDoMembro(admin, false).permissions).toEqual(["sdr.settings.manage"]);
    expect(permissoesDoMembro(admin, true).permissions).toEqual([
      "sdr.settings.manage",
      "sdr.assignments.view",
      "sdr.assignments.manage",
    ]);
  });

  it("manager SDR vê a equipe e trabalha leads, mas não gerencia", () => {
    const p = permissoesDoMembro({ ...SDR_AGENT, role: "manager" }, true);
    expect(p.permissions).toEqual([
      "sdr.assignments.view",
      "sdr.leads.prospect",
      "sdr.leads.qualify",
      "sdr.leads.handoff",
    ]);
  });
});
