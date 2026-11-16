/**
 * PATCH /api/v1/phone-numbers/[id] — o modo humano só fica com telefone do time.
 *
 * O modo e o telefone podem chegar em PATCHes separados (a tela troca o modo
 * num select e o telefone num campo), então a regra vale para o estado que
 * FICA: trocar para "Time humano" num número sem telefone recusa com 422, e
 * trocar quando o telefone já está salvo passa.
 */
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { PATCH } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function bancoCom(atual: { routing_mode: string; forward_to_phone: string | null }) {
  const atualizacoes: Array<Record<string, unknown>> = [];
  const filtros: Array<[string, unknown]> = [];
  const db = {
    from: () => {
      let mudanca: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        update: (m: Record<string, unknown>) => {
          mudanca = m;
          atualizacoes.push(m);
          return q;
        },
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return q;
        },
        maybeSingle: async () =>
          mudanca ? { data: { id: ID, ...atual, ...mudanca }, error: null } : { data: atual, error: null },
      };
      return q;
    },
  };
  return { db, atualizacoes, filtros };
}

function patch(corpo: Record<string, unknown>) {
  return PATCH(
    new NextRequest(`http://localhost/api/v1/phone-numbers/${ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id: ID }) },
  );
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" },
    org: { orgId: ORG, role: "manager" },
  } as never);
});

describe("PATCH phone-numbers — modo humano precisa de destino", () => {
  it("PATCH sem destino: trocar para humano num número sem telefone recusa com 422", async () => {
    const { db, atualizacoes } = bancoCom({ routing_mode: "ai", forward_to_phone: null });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await patch({ routing_mode: "human" });
    expect(res.status).toBe(422);
    expect(atualizacoes).toHaveLength(0);
  });

  it("trocar para humano quando o telefone já está salvo passa", async () => {
    const { db, atualizacoes, filtros } = bancoCom({ routing_mode: "ai", forward_to_phone: "+5527999990000" });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await patch({ routing_mode: "human" });
    expect(res.status).toBe(200);
    expect(atualizacoes).toEqual([{ routing_mode: "human" }]);
    expect(filtros).toContainEqual(["organization_id", ORG]);
  });

  it("modo e telefone no mesmo PATCH passam", async () => {
    const { db } = bancoCom({ routing_mode: "ai", forward_to_phone: null });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await patch({ routing_mode: "ai_then_human", forward_to_phone: "+5527999990000" });
    expect(res.status).toBe(200);
  });

  it("apagar o telefone de um número em modo humano recusa", async () => {
    const { db } = bancoCom({ routing_mode: "human", forward_to_phone: "+5527999990000" });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const res = await patch({ forward_to_phone: null });
    expect(res.status).toBe(422);
  });
});
