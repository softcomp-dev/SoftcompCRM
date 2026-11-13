/**
 * AS ROTAS DO ERP NO PROXY — o que abre para o Bearer e o que NÃO pode abrir.
 *
 * O `proxy.ts` só reconhece cookie: sem uma entrada em `lib/auth/public-paths.ts`
 * o Bearer leva 401 antes de chegar à rota. E uma entrada larga demais deixa
 * passar sem cookie um irmão que NÃO resolve token no handler. Esta cerca mede
 * os dois lados para cada rota do mapa `docs/api/integracao-erp.md`.
 */
import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

const ID = "3f1c2a9e-1b7d-4c55-9a51-2d1b0c7e8a10";

const ABREM: Record<string, string[]> = {
  "equipe e contato": [`/api/v1/contacts/${ID}`, "/api/v1/team/assignable"],
  "ler o negócio": ["/api/v1/leads", `/api/v1/leads/${ID}`, "/api/v1/leads/by-external/erp/PV-4821"],
  "fechar, nota e tarefa": [`/api/v1/leads/${ID}/win`, `/api/v1/leads/${ID}/lose`, `/api/v1/leads/${ID}/notes`, "/api/v1/tasks"],
  "automações e etiquetas": ["/api/v1/automation-rules", `/api/v1/automation-rules/${ID}`, "/api/v1/contact-tags"],
  "documentos, empresas e propostas": [
    `/api/v1/leads/${ID}/attachments`,
    `/api/v1/leads/${ID}/attachments/${ID}/media`,
    "/api/v1/companies",
    `/api/v1/companies/${ID}`,
    "/api/v1/proposals",
    `/api/v1/proposals/${ID}`,
  ],
};

const NAO_ABREM: Record<string, string[]> = {
  "equipe e contato": [
    "/api/v1/contacts/import",
    "/api/v1/contacts/duplicates",
    `/api/v1/contacts/${ID}/phones`,
    `/api/v1/contacts/${ID}/merge`,
    "/api/v1/contacts/nao-e-uuid",
    "/api/v1/team",
    "/api/v1/team/invite",
    `/api/v1/team/${ID}`,
    `/api/v1/team/${ID}/role`,
  ],
  "ler o negócio": [
    "/api/v1/leads/bulk",
    "/api/v1/leads/import",
    "/api/v1/leads/at-risk",
    "/api/v1/leads/by-external/erp",
    "/api/v1/leads/by-external/erp/PV-4821/extra",
    `/api/v1/leads/${ID}/clone`,
    `/api/v1/leads/${ID}/timeline`,
    `/api/v1/leads/${ID}/passar-ao-vendedor`,
  ],
  "fechar, nota e tarefa": [
    `/api/v1/tasks/${ID}`,
    "/api/v1/tasks/planos",
    `/api/v1/leads/${ID}/win/extra`,
    "/api/v1/leads/nao-e-uuid/win",
    `/api/v1/leads/${ID}/retomar`,
    `/api/v1/conversations/${ID}/notes`,
  ],
  "automações e etiquetas": [
    "/api/v1/automation-rules/runs",
    `/api/v1/automation-rules/runs/${ID}/resend`,
    `/api/v1/automation-rules/${ID}/runs`,
    "/api/v1/automation-rules/nao-e-uuid",
  ],
  "documentos, empresas e propostas": [
    `/api/v1/leads/${ID}/attachments/${ID}`,
    `/api/v1/companies/${ID}/enrich`,
    "/api/v1/companies/lookup",
    `/api/v1/proposals/${ID}/send`,
    `/api/v1/proposals/${ID}/documento`,
    `/api/v1/proposals/${ID}/previa`,
    `/api/v1/proposals/${ID}/decide`,
    `/api/v1/proposals/${ID}/revise`,
    `/api/v1/proposals/${ID}/modelo`,
    `/api/v1/proposals/${ID}/assistant`,
    `/api/v1/proposals/${ID}/preencher-com-conversa`,
  ],
};

describe("rotas do ERP no proxy", () => {
  for (const [grupo, caminhos] of Object.entries(ABREM)) {
    it.each(caminhos)(`${grupo}: %s passa pelo proxy (o handler decide)`, (c) => {
      expect(isPublicPath(c)).toBe(true);
    });
  }
  for (const [grupo, caminhos] of Object.entries(NAO_ABREM)) {
    it.each(caminhos)(`${grupo}: %s continua atrás do proxy`, (c) => {
      expect(isPublicPath(c)).toBe(false);
    });
  }
});
