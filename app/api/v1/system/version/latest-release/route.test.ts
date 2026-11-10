import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { consultarUltimaRelease } from "@/lib/system/conferir-release";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/system/conferir-release", () => ({ consultarUltimaRelease: vi.fn() }));

const SHA = "a".repeat(40);
const servico = (role: string, i: number) => ({
  role,
  container_id: String(i + 1).repeat(64),
  image_id: `sha256:${"2".repeat(64)}`,
  revision: SHA,
  base_version: "1.104.5",
  base_revision: SHA,
  source_verified: true,
  running: true,
  healthy: true,
});

function retrato(release_repo?: string | null) {
  return {
    schema: 1,
    collected_at: new Date().toISOString(),
    project: "crm",
    published_release: "v1.104.5",
    ...(release_repo === undefined ? {} : { release_repo }),
    services: ["app", "worker", "scheduler"].map((r, i) => servico(r, i)),
    issues: [],
  };
}

let linha: Record<string, unknown> | null;
let gravou = false;

beforeEach(() => {
  vi.clearAllMocks();
  gravou = false;
  linha = { runtime_confirmation: retrato("softcomp-dev/SoftcompCRM"), current_version: "", agent_last_seen_at: new Date().toISOString() };
  vi.mocked(loadAuthUser).mockResolvedValue({ id: "u", is_platform_admin: true, idioma: "pt-BR" } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linha, error: null }) }) }),
      update: () => {
        gravou = true;
        throw new Error("a rota não pode escrever");
      },
    }),
  } as never);
});

async function get() {
  const { GET } = await import("./route");
  return GET(new NextRequest("http://localhost/api/v1/system/version/latest-release"));
}

describe("GET /api/v1/system/version/latest-release", () => {
  it("pergunta ao repositório do retrato e diz que há versão nova", async () => {
    vi.mocked(consultarUltimaRelease).mockResolvedValue({
      ok: true,
      release: "v1.105.0",
      consultado_em: "2026-11-10T15:00:00.000Z",
      do_cache: false,
    });
    const r = await get();
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({
      repo: "softcomp-dev/SoftcompCRM",
      latest_release: "v1.105.0",
      installed_version: "1.104.5",
      newer: true,
      checked_at: "2026-11-10T15:00:00.000Z",
    });
    expect(consultarUltimaRelease).toHaveBeenCalledWith("softcomp-dev/SoftcompCRM");
    expect(gravou).toBe(false);
  });

  it("na mesma versão, newer é false", async () => {
    vi.mocked(consultarUltimaRelease).mockResolvedValue({ ok: true, release: "v1.104.5", consultado_em: "x", do_cache: true });
    expect((await (await get()).json()).data.newer).toBe(false);
  });

  it("agente antigo, sem release_repo: 409 e nenhuma consulta", async () => {
    linha = { ...linha, runtime_confirmation: retrato() };
    const r = await get();
    expect(r.status).toBe(409);
    expect(consultarUltimaRelease).not.toHaveBeenCalled();
  });

  it("GitHub fora do ar: 502, nunca 'você está em dia'", async () => {
    vi.mocked(consultarUltimaRelease).mockResolvedValue({ ok: false, motivo: "indisponivel" });
    const r = await get();
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe("provedor_indisponivel");
  });

  it("quem não administra o servidor recebe 403; sem sessão, 401", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({ id: "u", is_platform_admin: false, idioma: "pt-BR" } as never);
    expect((await get()).status).toBe(403);
    vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    expect((await get()).status).toBe(401);
    expect(consultarUltimaRelease).not.toHaveBeenCalled();
  });
});
