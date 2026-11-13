/**
 * /api/v1/automation-rules por Bearer `dsk_…` — o ERP configura "quando X,
 * chamar webhook" sem entrar na tela.
 *
 * O que esta suíte prova:
 * - GET (mcp:read) e POST/PATCH/DELETE (mcp:write) só com papel `admin` no token;
 * - tudo filtra a organização da LINHA DO TOKEN; id de outra org é 404;
 * - o segredo do webhook é cifrado na escrita e NUNCA volta (nem `secret_enc`);
 * - URL insegura (localhost, rede privada, http) é recusada 422 na escrita;
 * - `secret_enc` vindo do cliente é descartado;
 * - sem escopo 403, token inválido 401, acima do teto 429, agente de IA 403;
 * - `Idempotency-Key` repetida não cria a segunda regra;
 * - a sessão (cookie) segue pelo caminho de sempre.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/automation/campo-do-gatilho-de-data", () => ({
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO: "campo do contato",
  campoDoGatilhoDeDataEhDoContato: vi.fn(async () => ({ doContato: false })),
}));
// A cifra real é uma RPC do Postgres; aqui o que importa é o que sai gravado.
vi.mock("@/lib/webhooks/secrets", async () => {
  type A = { type: string; config?: Record<string, unknown> };
  return {
    encryptRuleActionSecrets: vi.fn(async (_db: unknown, acoes: A[]) =>
      acoes.map((a) => {
        if (a.type !== "call_webhook" || typeof a.config?.secret !== "string") return a;
        const { secret: _s, ...resto } = a.config;
        return { ...a, config: { ...resto, secret_enc: "cifrado-hex" } };
      }),
    ),
  };
});
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const REGRA = "11111111-1111-4111-8111-111111111111";
const REGRA_ALHEIA = "22222222-2222-4222-8222-222222222222";
const CHAVE = "5f0c6a52-6a3e-4b1d-9c1e-2f7a8b9c0d11";
const AUTH = { authorization: "Bearer dsk_abc_def" };

type Linha = Record<string, unknown>;

/** Banco em memória que APLICA os filtros `eq`/`gt` e o índice único de `idempotency_keys`. */
function banco(tabelas: Record<string, Linha[]>) {
  let seq = 0;
  const from = (nome: string) => {
    const linhas = (tabelas[nome] ??= []);
    const filtros: Array<(l: Linha) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Linha = {};
    const casa = () => linhas.filter((l) => filtros.every((f) => f(l)));
    const exec = (): { data: Linha[]; error: { code?: string; message?: string } | null } => {
      if (op === "insert") {
        if (
          nome === "idempotency_keys" &&
          linhas.some((l) => l.organization_id === payload.organization_id && l.key === payload.key && l.endpoint === payload.endpoint)
        ) {
          return { data: [], error: { code: "23505" } };
        }
        const nova = { id: `id-${++seq}`, is_active: false, ...payload };
        linhas.push(nova);
        return { data: [nova], error: null };
      }
      const alvo = casa();
      if (op === "update") for (const l of alvo) Object.assign(l, payload);
      if (op === "delete") for (const l of alvo) linhas.splice(linhas.indexOf(l), 1);
      return { data: alvo, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
      insert: (p: Linha) => ((op = "insert"), (payload = p), q),
      update: (p: Linha) => ((op = "update"), (payload = p), q),
      delete: () => ((op = "delete"), q),
      maybeSingle: async () => {
        const r = exec();
        return { data: r.data[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = exec();
        return { data: r.data[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => void) => res(exec()),
    };
    return q;
  };
  return { from } as never;
}

function tokenOk(over: Partial<{ role: string; scopes: string[]; actor: unknown }> = {}): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: (over.role ?? "admin") as never,
    actor: (over.actor ?? { type: "api_token", id: "tok-1", role: "admin" }) as never,
    apiTokenId: "tok-1",
    scopes: over.scopes ?? ["mcp:read", "mcp:write"],
  });
}

const regraDaOrg = (extra: Linha = {}): Linha => ({
  id: REGRA,
  organization_id: ORG,
  name: "Pedido pago",
  is_active: false,
  trigger_event: "lead.created",
  conditions: [],
  trigger_config: {},
  actions: [{ type: "call_webhook", config: { url: "https://erp.exemplo.com/hook", secret_enc: "cifrado-hex" } }],
  ...extra,
});
const regraAlheia = (): Linha => regraDaOrg({ id: REGRA_ALHEIA, organization_id: OUTRA_ORG, name: "Da outra org" });

const corpoNovo = {
  name: "Pedido pago",
  trigger_event: "lead.created",
  actions: [{ type: "call_webhook", config: { url: "https://erp.exemplo.com/hook", secret: "s3gredo" } }],
};

function req(metodo: string, url: string, body?: unknown, headers: Record<string, string> = AUTH) {
  return new NextRequest(`http://localhost${url}`, {
    method: metodo,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let tabelas: Record<string, Linha[]>;

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = { automation_rules: [regraDaOrg(), regraAlheia()], webhook_sources: [], idempotency_keys: [] };
  vi.mocked(createAdminClient).mockImplementation(() => banco(tabelas));
  vi.mocked(createClient).mockImplementation(async () => banco(tabelas));
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/v1/automation-rules — Bearer", () => {
  it("token admin com mcp:read lista só as regras da org do TOKEN, sem o segredo", async () => {
    tokenOk();
    const { GET } = await import("./route");

    const res = await GET(req("GET", "/api/v1/automation-rules"));
    const corpo = (await res.json()) as { data: Array<{ id: string; actions: Array<{ config: Record<string, unknown> }> }> };

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(corpo.data.map((r) => r.id)).toEqual([REGRA]);
    expect(corpo.data[0]!.actions[0]!.config).toEqual({
      url: "https://erp.exemplo.com/hook",
      secret_configured: true,
    });
    expect(JSON.stringify(corpo)).not.toContain("cifrado-hex");
  });

  it("token com papel abaixo de admin → 403, mesmo com o escopo certo", async () => {
    tokenOk({ role: "manager" });
    const { GET } = await import("./route");
    expect((await GET(req("GET", "/api/v1/automation-rules"))).status).toBe(403);
  });

  it("token sem mcp:read → 403; token inválido → 401", async () => {
    tokenOk({ scopes: ["mcp:write"] });
    const { GET } = await import("./route");
    expect((await GET(req("GET", "/api/v1/automation-rules"))).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(req("GET", "/api/v1/automation-rules"))).status).toBe(401);
  });

  it("sessão (cookie) segue pelo requireRole('manager') e pelo client da sessão", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as never);
    const { GET } = await import("./route");

    const res = await GET(req("GET", "/api/v1/automation-rules", undefined, {}));

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/automation-rules — Bearer", () => {
  it("201: cria na org do TOKEN, cifra o segredo e não o devolve; nasce pausada", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/automation-rules", corpoNovo));
    const corpo = (await res.json()) as { data: { id: string; is_active: boolean; actions: Array<{ config: Record<string, unknown> }> } };

    expect(res.status).toBe(201);
    expect(requireRole).not.toHaveBeenCalled();
    const gravada = tabelas.automation_rules!.find((l) => l.id === corpo.data.id)!;
    expect(gravada).toMatchObject({ organization_id: ORG, created_by_user_id: null, is_active: false });
    expect((gravada.actions as Array<{ config: Record<string, unknown> }>)[0]!.config).toEqual({
      url: "https://erp.exemplo.com/hook",
      secret_enc: "cifrado-hex",
    });
    expect(corpo.data.actions[0]!.config).toEqual({ url: "https://erp.exemplo.com/hook", secret_configured: true });
    expect(JSON.stringify(corpo)).not.toContain("s3gredo");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automation.rule_created", actorApiTokenId: "tok-1", organizationId: ORG }),
    );
  });

  it("organization_id no corpo não escolhe a org", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/automation-rules", { ...corpoNovo, organization_id: OUTRA_ORG }));

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(tabelas.automation_rules!.find((l) => l.id === data.id)).toMatchObject({ organization_id: ORG });
  });

  it("URL insegura → 422 e nada é gravado", async () => {
    tokenOk();
    const { POST } = await import("./route");
    for (const url of ["https://localhost/hook", "https://10.0.0.5/hook", "https://192.168.1.2/x", "https://[::1]/x"]) {
      const res = await POST(
        req("POST", "/api/v1/automation-rules", { ...corpoNovo, actions: [{ type: "call_webhook", config: { url } }] }),
      );
      expect(res.status, url).toBe(422);
    }
    expect(tabelas.automation_rules).toHaveLength(2);
  });

  it("secret_enc vindo do cliente é descartado: só a cifra do servidor grava ciphertext", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(
      req("POST", "/api/v1/automation-rules", {
        ...corpoNovo,
        actions: [{ type: "call_webhook", config: { url: "https://erp.exemplo.com/hook", secret_enc: "lixo" } }],
      }),
    );

    const { data } = (await res.json()) as { data: { id: string } };
    const gravada = tabelas.automation_rules!.find((l) => l.id === data.id)!;
    expect(JSON.stringify(gravada.actions)).not.toContain("lixo");
  });

  it("webhook_source_id de outra org → 422", async () => {
    tokenOk();
    tabelas.webhook_sources = [{ id: "33333333-3333-4333-8333-333333333333", organization_id: OUTRA_ORG }];
    const { POST } = await import("./route");

    const res = await POST(
      req("POST", "/api/v1/automation-rules", {
        name: "Por fonte",
        trigger_event: "webhook.received",
        trigger_config: { webhook_source_id: "33333333-3333-4333-8333-333333333333" },
        actions: [{ type: "add_tag", config: { tags: ["x"] } }],
      }),
    );

    expect([400, 422]).toContain(res.status);
    expect(tabelas.automation_rules).toHaveLength(2);
  });

  it("sem mcp:write → 403; papel manager → 403; token inválido → 401; nada é criado", async () => {
    const { POST } = await import("./route");
    tokenOk({ scopes: ["mcp:read"] });
    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo))).status).toBe(403);
    tokenOk({ role: "manager" });
    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo))).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo))).status).toBe(401);
    expect(tabelas.automation_rules).toHaveLength(2);
  });

  it("token de agente de IA → 403: a IA não escreve regra", async () => {
    tokenOk({ actor: { type: "ai_agent", id: "run-1", role: "admin", api_token_id: "tok-1" } });
    const { POST } = await import("./route");
    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo))).status).toBe(403);
    expect(tabelas.automation_rules).toHaveLength(2);
  });

  it("acima do teto → 429 com Retry-After", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/automation-rules", corpoNovo));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(tabelas.automation_rules).toHaveLength(2);
  });

  it("Idempotency-Key repetida com o mesmo corpo não cria a segunda; outro corpo → 409; chave ruim → 400", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const comChave = { ...AUTH, "idempotency-key": CHAVE };

    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo, comChave))).status).toBe(201);
    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo, comChave))).status).toBe(201);
    expect(tabelas.automation_rules).toHaveLength(3);
    // O recibo guardado é o da resposta sem segredo.
    expect(JSON.stringify(tabelas.idempotency_keys)).not.toContain("cifrado-hex");

    const outro = await POST(req("POST", "/api/v1/automation-rules", { ...corpoNovo, name: "Outra" }, comChave));
    expect(outro.status).toBe(409);
    expect((await POST(req("POST", "/api/v1/automation-rules", corpoNovo, { ...AUTH, "idempotency-key": "x" }))).status).toBe(400);
  });

  it("sessão (cookie) cria como sempre: requireRole('manager'), created_by_user_id da pessoa", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as never);
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/automation-rules", corpoNovo, {}));

    expect(res.status).toBe(201);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(validateBearerToken).not.toHaveBeenCalled();
    const { data } = (await res.json()) as { data: { id: string } };
    expect(tabelas.automation_rules!.find((l) => l.id === data.id)).toMatchObject({ created_by_user_id: "u-1" });
  });
});

describe("PATCH /api/v1/automation-rules/{id} — Bearer", () => {
  it("ativa a regra da org do token, grava a autoria e não devolve o segredo", async () => {
    tokenOk();
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(req("PATCH", `/api/v1/automation-rules/${REGRA}`, { is_active: true }), ctx(REGRA));
    const corpo = (await res.json()) as { data: { is_active: boolean } };

    expect(res.status).toBe(200);
    expect(corpo.data.is_active).toBe(true);
    expect(JSON.stringify(corpo)).not.toContain("cifrado-hex");
    expect(tabelas.automation_rules!.find((l) => l.id === REGRA)).toMatchObject({
      is_active: true,
      last_change_actor_kind: "system",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automation.rule_updated", actorApiTokenId: "tok-1" }),
    );
  });

  it("regra de outra organização → 404 e não é alterada", async () => {
    tokenOk();
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(req("PATCH", `/api/v1/automation-rules/${REGRA_ALHEIA}`, { is_active: true }), ctx(REGRA_ALHEIA));

    expect(res.status).toBe(404);
    expect(tabelas.automation_rules!.find((l) => l.id === REGRA_ALHEIA)).toMatchObject({ is_active: false });
  });

  it("trocar a URL para um endereço interno → 422 e a regra fica como estava", async () => {
    tokenOk();
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(
      req("PATCH", `/api/v1/automation-rules/${REGRA}`, {
        actions: [{ type: "call_webhook", config: { url: "http://10.1.1.1/x" } }],
      }),
      ctx(REGRA),
    );

    expect(res.status).toBe(422);
    expect(JSON.stringify(tabelas.automation_rules!.find((l) => l.id === REGRA)!.actions)).toContain("erp.exemplo.com");
  });

  it("novo segredo é cifrado e não volta; sem mcp:write → 403; sem teto → 429", async () => {
    tokenOk();
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      req("PATCH", `/api/v1/automation-rules/${REGRA}`, {
        actions: [{ type: "call_webhook", config: { url: "https://erp.exemplo.com/novo", secret: "outro" } }],
      }),
      ctx(REGRA),
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("outro");

    tokenOk({ scopes: ["mcp:read"] });
    expect((await PATCH(req("PATCH", `/api/v1/automation-rules/${REGRA}`, { is_active: true }), ctx(REGRA))).status).toBe(403);

    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await PATCH(req("PATCH", `/api/v1/automation-rules/${REGRA}`, { is_active: true }), ctx(REGRA))).status).toBe(429);
  });

  it("id que não é UUID → 404", async () => {
    tokenOk();
    const { PATCH } = await import("./[id]/route");
    expect((await PATCH(req("PATCH", "/api/v1/automation-rules/abc", { is_active: true }), ctx("abc"))).status).toBe(404);
  });

  it("sessão (cookie) edita como sempre", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as never);
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(req("PATCH", `/api/v1/automation-rules/${REGRA}`, { name: "Novo nome" }, {}), ctx(REGRA));

    expect(res.status).toBe(200);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(tabelas.automation_rules!.find((l) => l.id === REGRA)).toMatchObject({
      name: "Novo nome",
      last_change_actor_kind: "user",
    });
  });
});

describe("DELETE /api/v1/automation-rules/{id} — Bearer", () => {
  it("apaga a regra da org do token (204) e audita com o token", async () => {
    tokenOk();
    const { DELETE } = await import("./[id]/route");

    const res = await DELETE(req("DELETE", `/api/v1/automation-rules/${REGRA}`), ctx(REGRA));

    expect(res.status).toBe(204);
    expect(tabelas.automation_rules!.map((l) => l.id)).toEqual([REGRA_ALHEIA]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "automation.rule_deleted", actorApiTokenId: "tok-1" }),
    );
  });

  it("regra de outra organização → 404 e continua lá", async () => {
    tokenOk();
    const { DELETE } = await import("./[id]/route");

    const res = await DELETE(req("DELETE", `/api/v1/automation-rules/${REGRA_ALHEIA}`), ctx(REGRA_ALHEIA));

    expect(res.status).toBe(404);
    expect(tabelas.automation_rules).toHaveLength(2);
  });

  it("papel manager → 403; agente de IA → 403; acima do teto → 429", async () => {
    const { DELETE } = await import("./[id]/route");
    tokenOk({ role: "manager" });
    expect((await DELETE(req("DELETE", `/api/v1/automation-rules/${REGRA}`), ctx(REGRA))).status).toBe(403);
    tokenOk({ actor: { type: "ai_agent", id: "run-1", role: "admin", api_token_id: "tok-1" } });
    expect((await DELETE(req("DELETE", `/api/v1/automation-rules/${REGRA}`), ctx(REGRA))).status).toBe(403);
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await DELETE(req("DELETE", `/api/v1/automation-rules/${REGRA}`), ctx(REGRA))).status).toBe(429);
    expect(tabelas.automation_rules).toHaveLength(2);
  });
});
