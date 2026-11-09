/**
 * As duas garantias da tela /app/docs que não dependem de abrir o Swagger:
 *
 * - o "Testar" do Swagger nunca leva o cookie da sessão (senão a rota responde
 *   como a pessoa logada, e o teste mente sobre o que o ERP vai receber);
 * - /docs leva a /app/docs.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));

describe("SwaggerDaApi — requestInterceptor", () => {
  it("toda chamada do Testar sai com credentials: omit, mantendo o resto", async () => {
    const { semCookieDaSessao } = await import("./SwaggerDaApi");
    const req = {
      url: "https://crm.exemplo.com/api/v1/leads",
      method: "POST",
      headers: { Authorization: "Bearer dsk_x" },
      credentials: "same-origin" as RequestCredentials,
    };

    const saida = semCookieDaSessao(req);

    expect(saida.credentials).toBe("omit");
    expect(saida.headers).toEqual({ Authorization: "Bearer dsk_x" });
    expect(saida.url).toBe("https://crm.exemplo.com/api/v1/leads");
  });
});

describe("/docs", () => {
  it("redireciona para /app/docs", async () => {
    const { default: AtalhoDaDocumentacao } = await import("../../../docs/page");

    expect(() => AtalhoDaDocumentacao()).toThrow("REDIRECT:/app/docs");
  });
});
