import { describe, expect, it } from "vitest";

import { administraAgora, contarAdminsAtivos, ehRecusaDeUltimoAdmin } from "./ultimo-admin";

describe("administraAgora", () => {
  it("só admin, não revogado e com convite aceito", () => {
    const aceito = "2026-11-01T00:00:00.000Z";
    expect(administraAgora({ role: "admin", revoked_at: null, accepted_at: aceito })).toBe(true);
    expect(administraAgora({ role: "admin", revoked_at: null, accepted_at: null })).toBe(false);
    expect(administraAgora({ role: "admin", revoked_at: aceito, accepted_at: aceito })).toBe(false);
    expect(administraAgora({ role: "manager", revoked_at: null, accepted_at: aceito })).toBe(false);
  });
});

describe("contarAdminsAtivos", () => {
  it("pede ao banco só admin ativo E aceito, da organização", async () => {
    const filtros: string[] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push(`${c}=${String(v)}`), q),
      is: (c: string, v: unknown) => (filtros.push(`${c} is ${String(v)}`), q),
      not: (c: string, op: string, v: unknown) => {
        filtros.push(`${c} not ${op} ${String(v)}`);
        return Promise.resolve({ count: 2, error: null });
      },
    };
    const r = await contarAdminsAtivos({ from: () => q } as never, "org-1");
    expect(r).toEqual({ count: 2, error: null });
    expect(filtros).toEqual(["organization_id=org-1", "role=admin", "revoked_at is null", "accepted_at not is null"]);
  });
});

describe("ehRecusaDeUltimoAdmin", () => {
  it("reconhece a recusa do gatilho, e só ela", () => {
    expect(ehRecusaDeUltimoAdmin({ code: "PT409", message: "ultimo_admin" })).toBe(true);
    expect(ehRecusaDeUltimoAdmin({ code: "PT409", message: "gateway_replay" })).toBe(false);
    expect(ehRecusaDeUltimoAdmin({ code: "23505", message: "ultimo_admin" })).toBe(false);
    expect(ehRecusaDeUltimoAdmin(null)).toBe(false);
  });
});
