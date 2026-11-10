/**
 * Monta o Swagger UI pré-montado num elemento da página.
 *
 * Fica num módulo próprio por dois motivos: o `import()` dinâmico mantém o
 * bundle (~1,7 MB) fora de toda tela que não seja /app/docs, e o teste da tela
 * substitui este módulo inteiro sem precisar carregar o Swagger.
 */
import type { OpcoesDoSwaggerUI } from "swagger-ui-pronto";

export type OpcoesDeMontagem = Omit<OpcoesDoSwaggerUI, "domNode">;

export async function montarSwagger(no: HTMLElement, opcoes: OpcoesDeMontagem): Promise<void> {
  const modulo = (await import("swagger-ui-pronto")) as unknown as {
    default?: unknown;
  };
  // O bundle é UMD (CommonJS): conforme o empacotador, a função chega em
  // `default` ou em `default.default`.
  const candidato = (modulo.default as { default?: unknown } | undefined)?.default ?? modulo.default;
  if (typeof candidato !== "function") {
    throw new Error("swagger_ui_indisponivel");
  }
  (candidato as (o: OpcoesDoSwaggerUI) => unknown)({ domNode: no, ...opcoes });
}
