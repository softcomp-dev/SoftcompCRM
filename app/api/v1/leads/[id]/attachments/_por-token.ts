/**
 * Anexos do negócio chamados por Bearer `dsk_…` — o ERP anexa a NF e o contrato.
 *
 * O que muda em relação à sessão (`route.ts`):
 *  - a organização sai da LINHA DO TOKEN. O caminho do objeto no Storage é
 *    `<org do token>/leads/<lead lido do banco>/<campo>/<id>.<ext>` — nada do
 *    corpo ou da URL entra nele além do id do lead, que é conferido contra a
 *    organização antes (404 se for de outra);
 *  - o client é o de serviço (ignora a RLS): toda consulta filtra
 *    `organization_id` à mão;
 *  - `created_by` fica nulo (FK para auth.users; token não é usuário) e o
 *    audit leva o token como ator;
 *  - o teto de escrita por token vale ANTES de ler o corpo, e a mesma régua de
 *    tamanho/tipo da tela vale depois (`_limites.ts`).
 *
 * Remover anexo NÃO tem porta por token (a rota recusa o Bearer no DELETE).
 */
import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken, type AuthDual } from "@/lib/api/auth-dual";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { isLeadAttachmentPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { customFieldSchema } from "@/lib/schemas/settings";

import { BUCKET_DE_ANEXO, MIMES_DO_ANEXO, TAMANHO_MAXIMO_DO_ANEXO } from "./_limites";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUNAS = "id, file_name, storage_path, file_size, mime_type, created_at";

/** Falha interna com texto NOSSO (nunca o do banco) — vira 500 para quem integra. */
class FalhaDoAnexo extends Error {}

type Autorizado = Extract<AuthDual, { ok: true }>;

interface LinhaDeAnexo {
  id: string;
  file_name: string;
  storage_path: string;
  file_size: number | string;
  mime_type: string;
  created_at: string;
}

function serializar(row: LinhaDeAnexo, leadId: string) {
  return {
    id: row.id,
    name: row.file_name,
    path: row.storage_path,
    size: Number(row.file_size) || 0,
    type: row.mime_type,
    // O ERP baixa pelo mesmo caminho (`.../media`, 302 para link assinado de 60 s).
    url: `/api/v1/leads/${leadId}/attachments/${row.id}/media`,
    created_at: row.created_at,
    uploaded_at: row.created_at,
  };
}

function sanitizarNome(nome: string): string {
  return nome.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function leadDaOrganizacao(authz: Autorizado, leadId: string) {
  if (!UUID.test(leadId)) return null;
  const { data } = await authz.supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  return (data as { id: string; pipeline_id: string } | null) ?? null;
}

export async function listarPorToken(req: NextRequest, leadId: string, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  // Leitura por token também conta no teto (o desenho de GET /pipelines): rota
  // em PUBLIC_PATHS não tem contagem a montante.
  const tetoDeLeitura = await tetoDeEscritaDoToken(authz, "leads_attachments_leitura", requestId);
  if (tetoDeLeitura) return tetoDeLeitura;

  const lead = await leadDaOrganizacao(authz, leadId);
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  const fieldKey = req.nextUrl.searchParams.get("field_key");
  let query = authz.supabase
    .from("crm_lead_attachments")
    .select(COLUNAS)
    .eq("lead_id", lead.id)
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: true });
  if (fieldKey) query = query.eq("field_key", fieldKey);

  const { data, error } = await query;
  if (error) {
    logger.error("[leads/attachments] erro ao listar anexos por token", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar anexos.", 500, { requestId });
  }
  return ok({ files: ((data ?? []) as LinhaDeAnexo[]).map((r) => serializar(r, lead.id)) }, { requestId });
}

export async function anexarPorToken(req: NextRequest, leadId: string, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const suporte = await requireSupportWrite();
  if (suporte) return suporte;

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !UUID.test(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }
  const teto = await tetoDeEscritaDoToken(authz, "leads-attachments", requestId);
  if (teto) return teto;

  // 1 MB de folga para o envelope multipart; o `file.size` abaixo é o check do anexo.
  const corpo = await lerCorpoComTeto(req, TAMANHO_MAXIMO_DO_ANEXO + 1_048_576, {
    requestId,
    acimaDoTeto: "O arquivo excede o limite de 50 MB.",
  });
  if (!corpo.ok) return corpo.response;
  const form = await corpo.corpo.formData().catch(() => null);
  if (!form) return fail("validation_failed", "Requisição multipart inválida.", 400, { requestId });

  const file = form.get("file");
  const campoParsed = customFieldSchema.shape.key.safeParse(form.get("field_key"));
  if (!campoParsed.success) {
    return fail("validation_failed", campoParsed.error.issues[0]?.message ?? "Parâmetro inválido.", 422, {
      requestId,
      details: { campo: "field_key" },
    });
  }
  const fieldKey = campoParsed.data;
  if (!(file instanceof File)) {
    return fail("validation_failed", "Arquivo não informado.", 422, { requestId, details: { campo: "file" } });
  }
  if (file.size > TAMANHO_MAXIMO_DO_ANEXO) {
    return fail("payload_too_large", "O arquivo excede o limite de 50 MB.", 413, { requestId });
  }
  if (!MIMES_DO_ANEXO.has(file.type.toLowerCase())) {
    return fail("unsupported_media_type", "Formato inválido. Envie PDF ou imagem (PNG, JPG, WebP).", 415, {
      requestId,
      details: { mime: file.type },
    });
  }

  const lead = await leadDaOrganizacao(authz, leadId);
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  // Só se anexa a um campo `file` do NEGÓCIO que o funil deste lead declara.
  const settings = await settingsDoFunil(authz.supabase, lead.pipeline_id);
  const campo = camposDoFunil(settings as Record<string, unknown> | null).find((c) => c.key === fieldKey);
  if (!campo || campo.type !== "file" || escopoDoCampo(campo) !== "negocio") {
    return fail("validation_failed", "Este funil não tem um campo de arquivo com essa chave.", 422, {
      requestId,
      details: { campo: "field_key" },
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const orgId = authz.organizationId;

  const anexar = async () => {
    const nomeSeguro = sanitizarNome(file.name);
    const anexoId = randomUUID();
    const ext = nomeSeguro.includes(".") ? nomeSeguro.split(".").pop() : "bin";
    // Org da LINHA DO TOKEN e lead do BANCO: o banco confere o caminho contra eles.
    const caminho = `${orgId}/leads/${lead.id}/${fieldKey}/${anexoId}.${ext}`;

    const { error: uploadError } = await authz.supabase.storage
      .from(BUCKET_DE_ANEXO)
      .upload(caminho, bytes, { contentType: file.type, upsert: false });
    if (uploadError) {
      logger.error("[leads/attachments] upload por token falhou", { detalhe: uploadError.message, requestId });
      throw new FalhaDoAnexo("Falha ao salvar arquivo no armazenamento.");
    }

    const { data: inserido, error: insertError } = await authz.supabase
      .from("crm_lead_attachments")
      .insert({
        id: anexoId,
        organization_id: orgId,
        lead_id: lead.id,
        field_key: fieldKey,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        storage_path: caminho,
        created_by: null,
      })
      .select(COLUNAS)
      .single();
    if (insertError || !inserido) {
      logger.error("[leads/attachments] insert por token falhou", { detalhe: insertError?.message, requestId });
      // Não deixa arquivo órfão no Storage.
      await authz.supabase.storage.from(BUCKET_DE_ANEXO).remove([caminho]).catch(() => null);
      throw new FalhaDoAnexo("Falha ao registrar anexo no banco de dados.");
    }

    void audit({
      action: "lead.attachment_uploaded",
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: orgId,
      resourceType: "crm_leads",
      resourceId: lead.id,
      metadata: {
        attachment_id: anexoId,
        field_key: fieldKey,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        via: "token",
      },
      requestId,
    });

    // A linha do tempo do negócio (#3316): NOME e TIPO do arquivo, nunca o conteúdo.
    void emitLeadActivity(authz.supabase, {
      organizationId: orgId,
      leadId: lead.id,
      type: "document_attached",
      sourceModule: "leads/attachments",
      sourceId: anexoId,
      actor: authz.actor,
      reason: `Documento anexado ao campo ${campo.label ?? fieldKey}`,
      payload: { field_key: fieldKey, file_name: file.name, mime_type: file.type },
    }).catch(() => null);

    const { data: todos } = await authz.supabase
      .from("crm_lead_attachments")
      .select(COLUNAS)
      .eq("lead_id", lead.id)
      .eq("organization_id", orgId)
      .eq("field_key", fieldKey)
      .order("created_at", { ascending: true });

    return {
      resposta: {
        attachment: serializar(inserido as LinhaDeAnexo, lead.id),
        files: ((todos ?? []) as LinhaDeAnexo[]).map((r) => serializar(r, lead.id)),
      },
      status: 201,
    };
  };

  type Resposta = Awaited<ReturnType<typeof anexar>>["resposta"];
  try {
    const desfecho: DesfechoIdempotente<Resposta> =
      chave === null
        ? { tipo: "executou", ...(await anexar()) }
        : await comIdempotencia({
            db: authz.supabase,
            organizationId: orgId,
            endpoint: `POST /api/v1/leads/{id}/attachments`,
            chave,
            // A identidade da operação: o negócio, o campo e o CONTEÚDO do arquivo.
            corpo: {
              lead_id: lead.id,
              field_key: fieldKey,
              file_name: file.name,
              mime: file.type,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            executar: anexar,
          });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        "Esta Idempotency-Key já foi usada com outro corpo. Gere uma chave nova para um pedido diferente.",
        409,
        { requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        "O mesmo pedido ainda está sendo processado. Tente de novo em instantes, com a mesma chave.",
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof FalhaDoAnexo) return fail("internal_error", err.message, 500, { requestId });
    throw err;
  }
}

/**
 * Baixar o anexo: 302 para o link assinado (60 s) do Storage, como a tela. O
 * link só é assinado para o que mora sob `<org do token>/leads/<lead>/`.
 */
export async function baixarPorToken(
  req: NextRequest,
  leadId: string,
  anexoId: string,
  requestId: string,
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  // Leitura por token também conta no teto (o desenho de GET /pipelines): rota
  // em PUBLIC_PATHS não tem contagem a montante.
  const tetoDeLeitura = await tetoDeEscritaDoToken(authz, "leads_attachments_leitura", requestId);
  if (tetoDeLeitura) return tetoDeLeitura;

  const lead = await leadDaOrganizacao(authz, leadId);
  if (!lead) return fail("not_found", "Negócio não encontrado.", 404, { requestId });
  if (!UUID.test(anexoId)) return fail("not_found", "Anexo não encontrado.", 404, { requestId });

  const { data: anexo } = await authz.supabase
    .from("crm_lead_attachments")
    .select("id, storage_path")
    .eq("id", anexoId)
    .eq("lead_id", lead.id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  const caminho = (anexo as { storage_path?: string | null } | null)?.storage_path;
  if (!caminho || !isLeadAttachmentPathOwnedBy(caminho, authz.organizationId, lead.id)) {
    return fail("not_found", "Anexo não encontrado.", 404, { requestId });
  }

  const { data: assinado, error } = await authz.supabase.storage
    .from(BUCKET_DE_ANEXO)
    .createSignedUrl(caminho, 60);
  if (error || !assinado?.signedUrl) {
    return fail("internal_error", "Erro ao gerar link do arquivo.", 500, { requestId });
  }
  const resposta = NextResponse.redirect(assinado.signedUrl, 302);
  resposta.headers.set("X-Request-Id", requestId);
  resposta.headers.set("Cache-Control", "private, no-store");
  return resposta;
}
