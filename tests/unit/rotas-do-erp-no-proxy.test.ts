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
