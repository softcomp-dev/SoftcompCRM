/**
 * TRANSFERIR UM NEGÓCIO PARA OUTRA EMPRESA — as regras puras.
 *
 * Quem tem acesso a mais de uma empresa (vínculos em `user_organizations`)
 * precisa às vezes passar um negócio de uma para outra: o cliente que procurou
 * a filial errada, o lead que a matriz qualificou e a unidade vai atender. Sem
 * esta operação o único caminho era redigitar o cliente na outra empresa e
 * perder o negócio de vista na primeira.
 *
 * A troca segue o desenho da troca de funil (`lib/leads/clonar-para-funil.ts`,
 * P-01): o negócio é RECRIADO no destino e a origem ENCERRA com o motivo
 * canônico `moved_to_another_pipeline`, que `fn_attendant_metrics` já exclui da
 * contagem de perdas — transferir não é perder. Cada lado guarda o ponteiro para
 * o outro (`source_metadata.transferido_de` / `transferido_para`).
 *
 * O que NÃO vai junto, de propósito:
 *
 * - **Conversas, mensagens, anexos, tarefas e propostas.** Pertencem à empresa
 *   de origem (o canal de WhatsApp é dela) e ficam lá, no histórico do negócio
 *   encerrado. Copiar a conversa duplicaria mídia entre empresas sem que o canal
 *   do destino tenha participado de nada.
 * - **O CPF, o consentimento e os campos personalizados do CONTATO.** O CPF é
 *   cifrado e nunca sai do banco em claro; o consentimento foi dado à empresa
 *   de origem, não à de destino; e os campos do contato são declarados por
 *   empresa — copiar o jsonb cru gravaria no destino chaves que a ficha dele não
 *   conhece. Os campos do NEGÓCIO vão inteiros, como na troca de funil.
 * - **O dono que é agente de IA.** O agente é da empresa de origem. O dono
 *   humano vai como `dono_herdado`: se ele também atua no destino, continua
 *   dono; se não, o negócio nasce sem dono (regra do `createLeadHandler`).
 *
 * O CONTATO no destino é o mesmo cliente: achado pelo telefone e depois pelo
 * e-mail, e criado só se a empresa de destino ainda não o conhece. Duplicar o
 * cliente a cada transferência é o defeito que a deduplicação existe para evitar.
 */
import type { CreateLeadInput } from "@/lib/schemas";
import type { ContactCreate } from "@/lib/schemas/contacts";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import {
  montaPayloadDoClone,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";

/**
 * Tirar o negócio (e os dados do cliente) de uma empresa é decisão de gestão:
 * na origem o piso é `manager`. Receber é trabalho de quem atende: no destino,
 * `agent`. Quem é gerente numa e leitor noutra não empurra negócio para a segunda.
 */
export const PAPEL_MINIMO_NA_ORIGEM: Role = "manager";
export const PAPEL_MINIMO_NO_DESTINO: Role = "agent";

/** O `source` do contato que a transferência cria no destino. */
export const ORIGEM_DO_CONTATO_TRANSFERIDO = "transferencia_entre_empresas";

/** Um vínculo da pessoa, como `abrirVisaoConsolidada` devolve. */
export interface VinculoDaPessoa {
  organization_id: string;
  nome: string;
  role: Role;
}

export interface RecusaDaTransferencia {
  code: string;
  status: number;
  texto: string;
}

export const TEXTO_MESMA_EMPRESA = "O negócio já está nesta empresa. Escolha outra empresa.";
export const TEXTO_EMPRESA_NAO_ENCONTRADA = "Empresa de destino não encontrada.";
export const TEXTO_SEM_PAPEL_NO_DESTINO =
  "Você não tem permissão para criar negócios na empresa de destino.";
export const TEXTO_SEM_PAPEL_NA_ORIGEM =
  "Só gerentes e administradores transferem negócios para outra empresa.";
export const TEXTO_NEGOCIO_ENCERRADO =
  "Só negócios em andamento podem ser transferidos. Reabra o negócio antes.";

/**
 * As empresas para onde a pessoa pode levar um negócio da `origemId`: as
 * outras em que ela tem vínculo com papel suficiente para criar negócio.
 * A ordem é a dos vínculos (a do seletor de empresa).
 */
export function empresasDeDestino(
  vinculos: readonly VinculoDaPessoa[],
  origemId: string,
): VinculoDaPessoa[] {
  return vinculos.filter(
    (v) => v.organization_id !== origemId && roleAtLeast(v.role, PAPEL_MINIMO_NO_DESTINO),
  );
}

/**
 * A primeira recusa que a transferência merece, ou `null`. É pergunta de
 * PRÉ-VOO: tudo aqui se responde antes da primeira escrita.
 *
 * O papel efetivo de cada lado continua sendo conferido na rota por
 * `requireRole(..., { organizationId })`, que lê o banco e aplica MFA; esta
 * função recusa cedo, com a frase certa, o que a leitura dos vínculos já mostra.
 */
export function recusaDaTransferencia(input: {
  origemOrgId: string;
  destinoOrgId: string;
  vinculos: readonly VinculoDaPessoa[];
  statusDaOrigem: string;
}): RecusaDaTransferencia | null {
  if (input.origemOrgId === input.destinoOrgId) {
    return { code: "transfer_same_organization", status: 422, texto: TEXTO_MESMA_EMPRESA };
  }
  const naOrigem = input.vinculos.find((v) => v.organization_id === input.origemOrgId);
  if (!naOrigem || !roleAtLeast(naOrigem.role, PAPEL_MINIMO_NA_ORIGEM)) {
    return { code: "forbidden", status: 403, texto: TEXTO_SEM_PAPEL_NA_ORIGEM };
  }
  const noDestino = input.vinculos.find((v) => v.organization_id === input.destinoOrgId);
  if (!noDestino) {
    return { code: "organization_not_found", status: 404, texto: TEXTO_EMPRESA_NAO_ENCONTRADA };
  }
  if (!roleAtLeast(noDestino.role, PAPEL_MINIMO_NO_DESTINO)) {
    return { code: "forbidden", status: 403, texto: TEXTO_SEM_PAPEL_NO_DESTINO };
  }
  if (input.statusDaOrigem !== "open") {
    return { code: "lead_not_open", status: 422, texto: TEXTO_NEGOCIO_ENCERRADO };
  }
  return null;
}

/** As colunas do contato de origem que a transferência lê. */
export const COLUNAS_DO_CONTATO_DE_ORIGEM =
  "id, name, display_name, email, phone_number, birthdate, zip_code, street, number, complement, district, city, state, contact_type, tags";

export interface ContatoDaOrigem {
  id: string;
  name?: string | null;
  display_name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  birthdate?: string | null;
  zip_code?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  contact_type?: "cliente" | "fornecedor" | null;
  tags?: string[] | null;
}

/** Só o que tem valor: `undefined` deixa o default do banco decidir. */
function valor(v: string | null | undefined): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * A ficha que o contato ganha no destino quando a empresa ainda não o conhece.
 * Ver o cabeçalho para o que fica de fora (CPF, consentimento, campos).
 */
export function contatoParaODestino(
  contato: ContatoDaOrigem,
  origemOrgId: string,
): ContactCreate {
  const ficha: ContactCreate = {
    source: ORIGEM_DO_CONTATO_TRANSFERIDO,
    source_metadata: {
      transferido_de: { organization_id: origemOrgId, contact_id: contato.id },
    },
    tags: contato.tags ?? [],
  };
  const name = valor(contato.name);
  if (name) ficha.name = name;
  const displayName = valor(contato.display_name);
  if (displayName) ficha.display_name = displayName;
  const email = valor(contato.email);
  if (email) ficha.email = email;
  const phone = valor(contato.phone_number);
  if (phone) ficha.phone_number = phone;
  const birthdate = valor(contato.birthdate);
  if (birthdate) ficha.birthdate = birthdate;
  for (const campo of [
    "zip_code",
    "street",
    "number",
    "complement",
    "district",
    "city",
    "state",
  ] as const) {
    const v = valor(contato[campo]);
    if (v) ficha[campo] = v;
  }
  if (contato.contact_type) ficha.contact_type = contato.contact_type;
  return ficha;
}

/**
 * O negócio que nasce no destino. Parte do MESMO payload da troca de funil
 * (título, valor, recorrente, previsão, tags, campos do negócio) e troca o que
 * é da empresa de origem: contato, dono-agente, ponteiro de proveniência.
 */
export function montaPayloadDaTransferencia(
  origem: OrigemParaClonar,
  etapa: EtapaDoFunil,
  contatoNoDestinoId: string | null,
  origemOrgId: string,
): ReturnType<typeof montaPayloadDoClone> & CreateLeadInput {
  const base = montaPayloadDoClone(origem, etapa);
  const { clonado_de: _clonadoDe, ...metadataSemClone } = base.source_metadata as Record<
    string,
    unknown
  > & { clonado_de?: unknown };
  // `owner_agent_id` é um agente da empresa de origem: não existe no destino.
  const { owner_agent_id: _agente, ...semAgente } = base;
  return {
    ...semAgente,
    contact_id: contatoNoDestinoId,
    // Ponteiro para um negócio de OUTRA empresa não cabe em
    // `retomado_de_lead_id` (FK de mesma empresa); só a origem aberta é
    // transferida, e para ela o clone já devolve `null`.
    retomado_de_lead_id: null,
    source_metadata: {
      ...metadataSemClone,
      transferido_de: {
        organization_id: origemOrgId,
        lead_id: origem.id,
        pipeline_id: origem.pipeline_id,
      },
    },
  };
}
