import { describe, expect, it } from "vitest";

import {
  recusaDoNegocio,
  recusaDoSdr,
  recusaDoVendedor,
  vendedoresParaOSdr,
  type MembroDaPassagem,
} from "./passagem";

const SDR = "sdr-1";

const membro = (user_id: string, extra: Partial<MembroDaPassagem> = {}): MembroDaPassagem => ({
  user_id,
  role: "agent",
  revoked_at: null,
  sdr_since: null,
  accepted_at: "2026-11-01T00:00:00.000Z",
  ...extra,
});

describe("recusaDoSdr", () => {
  it("SDR ativo passa", () => {
    expect(recusaDoSdr(membro(SDR, { sdr_since: "2026-11-01T00:00:00.000Z" }), true)).toBeNull();
  });
  it("quem não é marcado, ou com a função desligada, não passa", () => {
    expect(recusaDoSdr(membro(SDR), true)).toBe("not_assigned");
    expect(recusaDoSdr(membro(SDR, { sdr_since: "2026-11-01T00:00:00.000Z" }), false)).toBe("feature_disabled");
    expect(recusaDoSdr(null, true)).toBe("not_a_member");
  });
});

describe("recusaDoNegocio", () => {
  it("negócio aberto do próprio SDR, sem dono ou de agente de IA passa", () => {
    expect(recusaDoNegocio({ status: "open", owner_user_id: SDR }, SDR)).toBeNull();
    expect(recusaDoNegocio({ status: "open", owner_user_id: null }, SDR)).toBeNull();
  });
  it("negócio encerrado ou de um colega não passa", () => {
    expect(recusaDoNegocio({ status: "won", owner_user_id: SDR }, SDR)).toBe("negocio_fechado");
    expect(recusaDoNegocio({ status: "open", owner_user_id: "colega" }, SDR)).toBe("negocio_de_outro");
  });
});

describe("recusaDoVendedor", () => {
  it("membro ativo que não é SDR recebe", () => {
    expect(recusaDoVendedor(membro("v1"), SDR, true)).toBeNull();
    expect(recusaDoVendedor(membro("v2", { role: "manager" }), SDR, true)).toBeNull();
  });
  it("recusa cada caso com o seu motivo", () => {
    expect(recusaDoVendedor(null, SDR, true)).toBe("vendedor_nao_encontrado");
    expect(recusaDoVendedor(membro(SDR), SDR, true)).toBe("vendedor_e_voce");
    expect(recusaDoVendedor(membro("v", { revoked_at: "2026-11-02T00:00:00.000Z" }), SDR, true)).toBe(
      "vendedor_inativo",
    );
    expect(recusaDoVendedor(membro("v", { accepted_at: null }), SDR, true)).toBe("vendedor_inativo");
    expect(recusaDoVendedor(membro("v", { role: "viewer" }), SDR, true)).toBe("vendedor_sem_papel");
    expect(recusaDoVendedor(membro("v", { sdr_since: "2026-11-01T00:00:00.000Z" }), SDR, true)).toBe(
      "vendedor_e_sdr",
    );
  });
  it("marca de SDR sem efeito (função desligada) não impede de receber", () => {
    expect(recusaDoVendedor(membro("v", { sdr_since: "2026-11-01T00:00:00.000Z" }), SDR, false)).toBeNull();
  });
});

describe("vendedoresParaOSdr", () => {
  it("lista só quem pode receber, sem o próprio SDR e sem os outros SDRs", () => {
    const equipe = [
      membro(SDR, { sdr_since: "2026-11-01T00:00:00.000Z" }),
      membro("outro-sdr", { sdr_since: "2026-11-01T00:00:00.000Z" }),
      membro("vendedor-a"),
      membro("leitor", { role: "viewer" }),
      membro("vendedor-b", { role: "admin" }),
      membro("saiu", { revoked_at: "2026-11-02T00:00:00.000Z" }),
    ];
    expect(vendedoresParaOSdr(equipe, SDR, true)).toEqual(["vendedor-a", "vendedor-b"]);
  });
});
