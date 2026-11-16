import { describe, expect, it } from "vitest";

import { situacaoDoTronco } from "./_client";

const SALVO_AS_10 = { updated_at: "2026-11-16T10:00:00Z" };

describe("situacaoDoTronco", () => {
  it("sem tronco, nada a mostrar", () => {
    expect(situacaoDoTronco(null, null)).toBeNull();
  });

  it("salvo e nunca conferido: aguardando o servidor", () => {
    expect(situacaoDoTronco(SALVO_AS_10, null)).toBe("aguardando");
  });

  it("estado aplicado ANTES do último salvamento é de outra configuração: aguardando", () => {
    expect(
      situacaoDoTronco(SALVO_AS_10, { state: "online", error: null, applied_at: "2026-11-16T09:00:00Z", checked_at: null }),
    ).toBe("aguardando");
  });

  it("aplicado depois do salvamento: vale o estado do servidor", () => {
    expect(
      situacaoDoTronco(SALVO_AS_10, { state: "offline", error: null, applied_at: "2026-11-16T10:00:20Z", checked_at: null }),
    ).toBe("offline");
  });

  it("erro aparece mesmo sem aplicação nova (o servidor tentou e falhou)", () => {
    expect(
      situacaoDoTronco(SALVO_AS_10, { state: "erro", error: "403", applied_at: null, checked_at: null }),
    ).toBe("erro");
  });
});
