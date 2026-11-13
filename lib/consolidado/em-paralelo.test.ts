import { describe, expect, it } from "vitest";

import { emParalelo } from "./em-paralelo";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("emParalelo", () => {
  it("devolve na ordem dos itens, mesmo quando o último termina primeiro", async () => {
    const saida = await emParalelo([30, 10, 1], async (ms) => (await esperar(ms), ms), 3);
    expect(saida).toEqual([30, 10, 1]);
  });

  it("nunca roda mais que o teto ao mesmo tempo", async () => {
    let agora = 0;
    let pico = 0;
    await emParalelo(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        pico = Math.max(pico, ++agora);
        await esperar(2);
        agora--;
      },
      4,
    );
    expect(pico).toBe(4);
  });

  it("a primeira falha rejeita e nada novo começa depois dela", async () => {
    const iniciados: number[] = [];
    await expect(
      emParalelo(
        [0, 1, 2, 3, 4, 5],
        async (i) => {
          iniciados.push(i);
          await esperar(2);
          if (i === 1) throw new Error("boom");
          return i;
        },
        2,
      ),
    ).rejects.toThrow("boom");
    expect(iniciados.length).toBeLessThan(6);
  });

  it("lista vazia devolve lista vazia", async () => {
    expect(await emParalelo([], async () => 1)).toEqual([]);
  });
});
