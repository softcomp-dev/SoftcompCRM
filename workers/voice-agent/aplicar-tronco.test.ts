/**
 * O worker leva o tronco salvo na tela ao Asterisk (`./aplicar-tronco.ts`).
 *
 * Banco em memória, ARI gravador e a decifragem como dublê. Mede: aplica o que
 * mudou, não reaplica o que não mudou (e não escreve estado igual), remove o
 * tronco desativado, e o erro da ARI vira estado `erro` SEM a senha.
 *
 * SABOTAGEM: remover o laço `for (const o of objetosDoTronco(t, senha))` =
 * o caso "aplica" fica vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashDoTronco } from "@/lib/voip/tronco-dinamico";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const fakes = vi.hoisted(() => ({
  troncos: [] as Array<Record<string, unknown>>,
  estados: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
  ari: [] as Array<[string, ...unknown[]]>,
  falharAri: null as null | Error,
  estadoDoEndpoint: "online",
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: async () =>
        tabela === "voip_trunk_settings"
          ? { data: fakes.troncos, error: null }
          : { data: fakes.estados, error: null },
      upsert: async (linha: Record<string, unknown>) => {
        fakes.upserts.push(linha);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.alloc(0),
  decryptKey: () => "s3nha-secreta",
}));
vi.mock("@/lib/voip/ariClient", () => ({
  gravarObjetoPjsip: async (...args: unknown[]) => {
    fakes.ari.push(["gravar", ...args]);
    if (fakes.falharAri) throw fakes.falharAri;
  },
  apagarObjetoPjsip: async (...args: unknown[]) => {
    fakes.ari.push(["apagar", ...args]);
  },
  estadoDoEndpoint: async () => fakes.estadoDoEndpoint,
}));

import { rodadaDoTronco } from "./aplicar-tronco";

function tronco(extra: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    host: "sip.operadora.example",
    port: 5060,
    username: "1234",
    from_domain: null,
    endpoint_name: `org-${ORG}-trunk-endpoint`,
    is_active: true,
    password_encrypted: "\\x01",
    password_iv: "\\x02",
    password_tag: "\\x03",
    ...extra,
  };
}

beforeEach(() => {
  fakes.troncos = [];
  fakes.estados = [];
  fakes.upserts = [];
  fakes.ari = [];
  fakes.falharAri = null;
  fakes.estadoDoEndpoint = "online";
});

describe("aplicar o tronco salvo na tela", () => {
  it("aplica: tronco novo vai ao Asterisk e o estado diz online, com o hash", async () => {
    fakes.troncos = [tronco()];
    await rodadaDoTronco();

    expect(fakes.ari.filter((c) => c[0] === "gravar").map((c) => c[2])).toEqual([
      "auth",
      "aor",
      "endpoint",
      "identify",
      "registration",
    ]);
    expect(fakes.upserts).toEqual([
      expect.objectContaining({ organization_id: ORG, state: "online", applied_config_hash: hashDoTronco(tronco() as never) }),
    ]);
  });

  it("não reaplica o que já foi aplicado, e estado igual não gera escrita", async () => {
    fakes.troncos = [tronco()];
    fakes.estados = [
      { organization_id: ORG, applied_config_hash: hashDoTronco(tronco() as never), state: "online", error: null },
    ];
    await rodadaDoTronco();
    expect(fakes.ari).toHaveLength(0);
    expect(fakes.upserts).toHaveLength(0);
  });

  it("a operadora parou de responder: só o estado muda, sem reaplicar", async () => {
    fakes.troncos = [tronco()];
    fakes.estados = [
      { organization_id: ORG, applied_config_hash: hashDoTronco(tronco() as never), state: "online", error: null },
    ];
    fakes.estadoDoEndpoint = "offline";
    await rodadaDoTronco();
    expect(fakes.ari).toHaveLength(0);
    expect(fakes.upserts).toEqual([expect.objectContaining({ state: "offline" })]);
  });

  it("desativado na tela: os objetos saem do Asterisk, na ordem inversa", async () => {
    fakes.troncos = [tronco({ is_active: false })];
    await rodadaDoTronco();
    expect(fakes.ari.map((c) => `${c[0]}:${c[2]}`)).toEqual([
      "apagar:registration",
      "apagar:identify",
      "apagar:endpoint",
      "apagar:aor",
      "apagar:auth",
    ]);
    expect(fakes.upserts).toEqual([expect.objectContaining({ state: "desligado" })]);
  });

  it("erro da ARI vira estado erro, e a senha nunca chega ao banco", async () => {
    fakes.troncos = [tronco()];
    fakes.falharAri = new Error("ARI PUT ... -> 403: password=s3nha-secreta not writable");
    await rodadaDoTronco();
    expect(fakes.upserts).toHaveLength(1);
    expect(fakes.upserts[0]).toMatchObject({ state: "erro" });
    expect(String(fakes.upserts[0]!.error)).not.toContain("s3nha-secreta");
    // Sem aplicar, o hash não é gravado: a próxima rodada tenta de novo.
    expect(fakes.upserts[0]!.applied_config_hash).toBeNull();
  });
});
