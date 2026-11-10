/**
 * Tipos do Swagger UI pré-montado (apelido `swagger-ui-pronto` em next.config.ts
 * e vitest.config.ts). Só o que a tela /app/docs usa.
 */
declare module "swagger-ui-pronto" {
  export interface OpcoesDoSwaggerUI {
    domNode: HTMLElement;
    spec: Record<string, unknown>;
    docExpansion?: "list" | "full" | "none";
    defaultModelsExpandDepth?: number;
    persistAuthorization?: boolean;
    requestInterceptor?: (req: Record<string, unknown>) => Record<string, unknown>;
  }
  const SwaggerUIBundle: (opcoes: OpcoesDoSwaggerUI) => unknown;
  export default SwaggerUIBundle;
}
