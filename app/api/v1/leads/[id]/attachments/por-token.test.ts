// @vitest-environment node
/**
 * Anexos do negócio por Bearer `dsk_…` — o ERP anexa a NF e o contrato.
 *
 * O que esta suíte prova, com um banco em memória que APLICA os filtros:
 * - GET lista e POST anexa na org do TOKEN; o objeto vai para o Storage sob
 *   `<org do token>/leads/<lead>/…` (nada do corpo entra no caminho);
 * - o mesmo teto (50 MB) e os mesmos tipos (PDF/PNG/JPG/WebP) da tela;
 * - escopo errado → 403; token inválido → 401; teto de escrita → 429;
 * - isolamento: negócio de OUTRA organização → 404; anexo de outra org não baixa;
 * - `Idempotency-Key` repetida não sobe o arquivo de novo;
 * - DELETE com Bearer é recusado; a sessão segue o caminho de sempre.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";

import { criarBanco, type BancoEmMemoria } from "../../../proposals/_banco-em-memoria";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => undefined) }));

let banco: BancoEmMemoria;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.client }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const LEAD = "11111111-1111-4111-8111-111111111111";
const LEAD_ALHEIO = "22222222-2222-4222-8222-222222222222";
const ANEXO = "88888888-8888-4888-8888-888888888888";
const ANEXO_ALHEIO = "99999999-9999-4999-8999-999999999999";
const CHAVE = "5f0c6a52-6a3e-4b1d-9c1e-2f7a8b9c0d11";
const AUTH = { authorization: "Bearer dsk_abc_def" };

function tokenOk(scopes: string[] = ["mcp:read", "mcp:write"], role = "agent"): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: role as never,
    actor: { type: "api_token", id: "tok-1", role: role as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

function envio(
  leadId: string,
  opcoes: { campo?: string; arquivo?: File | null; headers?: Record<string, string> } = {},
): NextRequest {
  const form = new FormData();
  form.set("field_key", opcoes.campo ?? "nota_fiscal");
  if (opcoes.arquivo !== null) {
    form.set("file", opcoes.arquivo ?? new File([new Uint8Array([1, 2, 3])], "nf 123.pdf", { type: "application/pdf" }));
  }
  return new NextRequest(`http://localhost/api/v1/leads/${leadId}/attachments`, {
    method: "POST",
    body: form,
    headers: opcoes.headers ?? AUTH,
  });
}

const get = (caminho: string, headers: Record<string, string> = AUTH) =>
  new NextRequest(`http://localhost${caminho}`, { method: "GET", headers });

const ctx = (leadId: string) => ({ params: Promise.resolve({ id: leadId }) });
const ctxMidia = (leadId: string, anexoId: string) => ({ params: Promise.resolve({ id: leadId, attachmentId: anexoId }) });

beforeEach(() => {
  vi.clearAllMocks();
  banco = criarBanco();
  banco.tabelas.crm_leads = [
    { id: LEAD, organization_id: ORG, pipeline_id: FUNIL },
    { id: LEAD_ALHEIO, organization_id: OUTRA_ORG, pipeline_id: FUNIL },
  ];
  banco.tabelas.crm_pipelines = [
    {
      id: FUNIL,
      organization_id: ORG,
      settings: { fields: [{ key: "nota_fiscal", label: "Nota fiscal", type: "file" }] },
    },
  ];
  banco.tabelas.crm_lead_attachments = [
    {
      id: ANEXO,
      organization_id: ORG,
      lead_id: LEAD,
      field_key: "nota_fiscal",
      file_name: "nf.pdf",
      file_size: 3,
      mime_type: "application/pdf",
      storage_path: `${ORG}/leads/${LEAD}/nota_fiscal/${ANEXO}.pdf`,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: ANEXO_ALHEIO,
      organization_id: OUTRA_ORG,
      lead_id: LEAD_ALHEIO,
      field_key: "nota_fiscal",
      file_name: "alheio.pdf",
      file_size: 3,
      mime_type: "application/pdf",
      storage_path: `${OUTRA_ORG}/leads/${LEAD_ALHEIO}/nota_fiscal/${ANEXO_ALHEIO}.pdf`,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  tokenOk();
});

describe("GET /api/v1/leads/{id}/attachments — Bearer", () => {
  it("lista os anexos do negócio da org do TOKEN (viewer + mcp:read)", async () => {
    tokenOk(["mcp:read"], "viewer");
    const { GET } = await import("./route");
    const res = await GET(get(`/api/v1/leads/${LEAD}/attachments`), ctx(LEAD));
    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    const { data } = (await res.json()) as { data: { files: Array<{ id: string }> } };
    expect(data.files.map((f) => f.id)).toEqual([ANEXO]);
  });

  it("negócio de OUTRA organização → 404, sem listar", async () => {
    const { GET } = await import("./route");
    const res = await GET(get(`/api/v1/leads/${LEAD_ALHEIO}/attachments`), ctx(LEAD_ALHEIO));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("alheio");
  });

  it("sem mcp:read → 403; token inválido → 401", async () => {
    const { GET } = await import("./route");
    tokenOk(["mcp:write"]);
    expect((await GET(get(`/api/v1/leads/${LEAD}/attachments`), ctx(LEAD))).status).toBe(403);
    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(get(`/api/v1/leads/${LEAD}/attachments`), ctx(LEAD))).status).toBe(401);
  });
});

describe("POST /api/v1/leads/{id}/attachments — Bearer", () => {
  it("anexa: o objeto vai para <org do token>/leads/<lead>/<campo>/ e a linha leva a org do token", async () => {
    const { POST } = await import("./route");
    const res = await POST(envio(LEAD), ctx(LEAD));
    expect(res.status).toBe(201);
    expect(banco.uploads).toHaveLength(1);
    expect(banco.uploads[0]!.bucket).toBe("internal-media");
    expect(banco.uploads[0]!.caminho.startsWith(`${ORG}/leads/${LEAD}/nota_fiscal/`)).toBe(true);
    const nova = banco.tabelas.crm_lead_attachments!.find((a) => a.file_name === "nf 123.pdf");
    expect(nova).toMatchObject({ organization_id: ORG, lead_id: LEAD, field_key: "nota_fiscal", created_by: null });
    const { data } = (await res.json()) as { data: { attachment: { url: string }; files: unknown[] } };
    expect(data.attachment.url).toContain(`/api/v1/leads/${LEAD}/attachments/`);
    expect(data.files).toHaveLength(2);
  });

  it("negócio de OUTRA organização → 404 e nada vai para o Storage", async () => {
    const { POST } = await import("./route");
    const res = await POST(envio(LEAD_ALHEIO), ctx(LEAD_ALHEIO));
    expect(res.status).toBe(404);
    expect(banco.uploads).toHaveLength(0);
  });

  it("tipo fora de PDF/imagem → 415; sem arquivo → 422; campo que o funil não declara → 422", async () => {
    const { POST } = await import("./route");
    const exe = new File([new Uint8Array([1])], "x.exe", { type: "application/x-msdownload" });
    expect((await POST(envio(LEAD, { arquivo: exe }), ctx(LEAD))).status).toBe(415);
    expect((await POST(envio(LEAD, { arquivo: null }), ctx(LEAD))).status).toBe(422);
    expect((await POST(envio(LEAD, { campo: "inexistente" }), ctx(LEAD))).status).toBe(422);
    expect(banco.uploads).toHaveLength(0);
  });

  it("acima de 50 MB → 413 (o mesmo teto da tela)", async () => {
    const { POST } = await import("./route");
    const grande = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "grande.pdf", { type: "application/pdf" });
    const res = await POST(envio(LEAD, { arquivo: grande }), ctx(LEAD));
    expect(res.status).toBe(413);
    expect(banco.uploads).toHaveLength(0);
  });

  it("leitura por token conta no teto: acima dele, 429", async () => {
    const { GET } = await import("./route");
    tokenOk(["mcp:read"]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await GET(get(`/api/v1/leads/${LEAD}/attachments`), ctx(LEAD))).status).toBe(429);
  });

  it("sem mcp:write → 403; acima do teto → 429; nada sobe", async () => {
    const { POST } = await import("./route");
    tokenOk(["mcp:read"]);
    expect((await POST(envio(LEAD), ctx(LEAD))).status).toBe(403);
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(envio(LEAD), ctx(LEAD));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(banco.uploads).toHaveLength(0);
  });

  it("falha ao registrar a linha: o arquivo enviado é removido e o erro não vaza texto do banco", async () => {
    banco.falharInsert.crm_lead_attachments = { message: "violates constraint x" };
    const { POST } = await import("./route");
    const res = await POST(envio(LEAD), ctx(LEAD));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("constraint");
    expect(banco.removidos).toEqual([banco.uploads[0]!.caminho]);
  });

  it("Idempotency-Key repetida devolve o mesmo anexo e sobe o arquivo UMA vez", async () => {
    const { POST } = await import("./route");
    const h = { ...AUTH, "idempotency-key": CHAVE };
    const a = await POST(envio(LEAD, { headers: h }), ctx(LEAD));
    const b = await POST(envio(LEAD, { headers: h }), ctx(LEAD));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(banco.uploads).toHaveLength(1);
    const ida = ((await a.json()) as { data: { attachment: { id: string } } }).data.attachment.id;
    const idb = ((await b.json()) as { data: { attachment: { id: string } } }).data.attachment.id;
    expect(idb).toBe(ida);
    // Outro arquivo com a mesma chave é conflito.
    const outro = new File([new Uint8Array([9, 9])], "outro.pdf", { type: "application/pdf" });
    const c = await POST(envio(LEAD, { headers: h, arquivo: outro }), ctx(LEAD));
    expect(c.status).toBe(409);
  });
});

describe("DELETE /api/v1/leads/{id}/attachments — Bearer", () => {
  it("é recusado (403) e o anexo continua lá", async () => {
    const { DELETE } = await import("./route");
    const req = new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, {
      method: "DELETE",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ field_key: "nota_fiscal", attachment_id: ANEXO }),
    });
    const res = await DELETE(req, ctx(LEAD));
    expect(res.status).toBe(403);
    expect(banco.tabelas.crm_lead_attachments!.some((a) => a.id === ANEXO)).toBe(true);
    expect(banco.removidos).toHaveLength(0);
    expect(requireRole).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/leads/{id}/attachments/{attachmentId}/media — Bearer", () => {
  it("302 para o link assinado do anexo da org do token", async () => {
    tokenOk(["mcp:read"], "viewer");
    const { GET } = await import("./[attachmentId]/media/route");
    const res = await GET(get(`/api/v1/leads/${LEAD}/attachments/${ANEXO}/media`), ctxMidia(LEAD, ANEXO));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`${ORG}/leads/${LEAD}/nota_fiscal/${ANEXO}.pdf`);
  });

  it("anexo/negócio de OUTRA organização → 404, nenhum link assinado", async () => {
    const { GET } = await import("./[attachmentId]/media/route");
    const a = await GET(get(`/api/v1/leads/${LEAD_ALHEIO}/attachments/${ANEXO_ALHEIO}/media`), ctxMidia(LEAD_ALHEIO, ANEXO_ALHEIO));
    expect(a.status).toBe(404);
    // Anexo alheio pedido pelo negócio PRÓPRIO também não resolve.
    const b = await GET(get(`/api/v1/leads/${LEAD}/attachments/${ANEXO_ALHEIO}/media`), ctxMidia(LEAD, ANEXO_ALHEIO));
    expect(b.status).toBe(404);
  });

  it("sem mcp:read → 403", async () => {
    tokenOk(["mcp:write"]);
    const { GET } = await import("./[attachmentId]/media/route");
    expect((await GET(get(`/api/v1/leads/${LEAD}/attachments/${ANEXO}/media`), ctxMidia(LEAD, ANEXO))).status).toBe(403);
  });
});

describe("a sessão segue o caminho de sempre", () => {
  it("GET sem Bearer passa pelo requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) } as never);
    const { GET } = await import("./route");
    const res = await GET(get(`/api/v1/leads/${LEAD}/attachments`, {}), ctx(LEAD));
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledOnce();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});
