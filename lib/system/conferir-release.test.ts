import { beforeEach, describe, expect, it, vi } from "vitest";

import { consultarUltimaRelease, limparCacheDaConsulta } from "./conferir-release";
import { runtimeConfirmationSchema } from "./runtime-identity";

function responde(status: number, corpo: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch;
}

beforeEach(() => limparCacheDaConsulta());

describe("consultarUltimaRelease", () => {
  it("pergunta /releases/latest do repositório e devolve a tag", async () => {
    const f = responde(200, { tag_name: "v1.105.0", draft: false });
    const r = await consultarUltimaRelease("softcomp-dev/SoftcompCRM", { fetchImpl: f, agora: () => 0 });
    expect(r).toEqual({ ok: true, release: "v1.105.0", consultado_em: new Date(0).toISOString(), do_cache: false });
    expect(vi.mocked(f).mock.calls[0]![0]).toBe("https://api.github.com/repos/softcomp-dev/SoftcompCRM/releases/latest");
  });

  it("recusa repositório fora da forma dono/repo sem tocar a rede", async () => {
    const f = responde(200, { tag_name: "v1.0.0" });
    for (const repo of ["evil.com/../x", "a/b/c", "a", "https://x/y", "a b/c"]) {
      expect(await consultarUltimaRelease(repo, { fetchImpl: f })).toEqual({ ok: false, motivo: "repositorio_invalido" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("guarda a resposta por 60 s e pergunta de novo depois", async () => {
    const f = responde(200, { tag_name: "v1.105.0" });
    let t = 0;
    await consultarUltimaRelease("o/r", { fetchImpl: f, agora: () => t });
    t = 59_000;
    expect((await consultarUltimaRelease("o/r", { fetchImpl: f, agora: () => t })).ok && "cache").toBe("cache");
    expect(f).toHaveBeenCalledTimes(1);
    t = 61_000;
    await consultarUltimaRelease("o/r", { fetchImpl: f, agora: () => t });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("distingue sem release (404), fora do ar e resposta torta — e não guarda erro", async () => {
    expect(await consultarUltimaRelease("o/r", { fetchImpl: responde(404, {}) })).toEqual({ ok: false, motivo: "sem_release" });
    expect(await consultarUltimaRelease("o/r", { fetchImpl: responde(403, {}) })).toEqual({ ok: false, motivo: "indisponivel" });
    const caiu = vi.fn(async () => {
      throw new Error("rede");
    }) as unknown as typeof fetch;
    expect(await consultarUltimaRelease("o/r", { fetchImpl: caiu })).toEqual({ ok: false, motivo: "indisponivel" });
    expect(await consultarUltimaRelease("o/r", { fetchImpl: responde(200, { tag_name: "latest" }) })).toEqual({
      ok: false,
      motivo: "resposta_invalida",
    });
    const certo = responde(200, { tag_name: "v2.0.0" });
    expect((await consultarUltimaRelease("o/r", { fetchImpl: certo })).ok).toBe(true);
    expect(certo).toHaveBeenCalledTimes(1);
  });
});

describe("runtimeConfirmationSchema.release_repo", () => {
  const base = {
    schema: 1,
    collected_at: "2026-11-10T12:00:00Z",
    project: "crm",
    services: ["app", "worker", "scheduler"].map((role) => ({
      role,
      container_id: null,
      image_id: null,
      revision: null,
      base_version: null,
      base_revision: null,
      source_verified: false,
      running: true,
      healthy: true,
    })),
    issues: [],
  };

  it("aceita dono/repo, null e ausência (agente antigo)", () => {
    expect(runtimeConfirmationSchema.parse({ ...base, release_repo: "a/b" }).release_repo).toBe("a/b");
    expect(runtimeConfirmationSchema.safeParse({ ...base, release_repo: null }).success).toBe(true);
    expect(runtimeConfirmationSchema.safeParse(base).success).toBe(true);
  });

  it("repositório fora da forma vira null, sem reprovar o retrato (o heartbeat não pode levar 422)", () => {
    const r = runtimeConfirmationSchema.safeParse({ ...base, release_repo: "https://evil/x" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.release_repo).toBeNull();
  });
});
