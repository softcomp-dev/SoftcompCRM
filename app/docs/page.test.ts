/** /docs é atalho: leva à documentação da API dentro do CRM (/app/docs). */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));

describe("/docs", () => {
  it("redireciona para /app/docs", async () => {
    const { default: AtalhoDaDocumentacao } = await import("./page");

    expect(() => AtalhoDaDocumentacao()).toThrow("REDIRECT:/app/docs");
  });
});
