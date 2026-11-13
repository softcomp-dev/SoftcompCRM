/**
 * `Promise.all` com teto de simultâneos, para o leque da visão consolidada.
 *
 * Cada empresa custa várias consultas (conversas: quatro ou mais; funil: duas
 * por funil). Quem tem dezenas de empresas disparava todas de uma vez a cada
 * recarga — centenas de consultas simultâneas contra um pooler que, numa VPS,
 * tem poucas dezenas de conexões. O teto troca um pico por uma fila curta.
 *
 * Contrato igual ao de `Promise.all(itens.map(fn))`: resultados NA ORDEM de
 * `itens`, e a primeira falha rejeita (nada novo começa depois dela).
 */
export const SIMULTANEOS_NA_VISAO = 8;

export async function emParalelo<T, R>(
  itens: readonly T[],
  fn: (item: T, indice: number) => Promise<R>,
  limite: number = SIMULTANEOS_NA_VISAO,
): Promise<R[]> {
  const resultados = new Array<R>(itens.length);
  let proximo = 0;
  let falhou = false;

  const trabalhar = async (): Promise<void> => {
    while (!falhou) {
      const indice = proximo++;
      if (indice >= itens.length) return;
      try {
        resultados[indice] = await fn(itens[indice] as T, indice);
      } catch (erro) {
        falhou = true;
        throw erro;
      }
    }
  };

  const trabalhadores = Math.max(1, Math.min(limite, itens.length));
  await Promise.all(Array.from({ length: trabalhadores }, trabalhar));
  return resultados;
}
