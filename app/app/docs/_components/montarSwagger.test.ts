/**
 * O apelido `swagger-ui-pronto` resolve para o Swagger UI PRÉ-MONTADO e entrega
 * a função de montagem.
 *
 * O defeito da v1.104.4 (toda operação girando para sempre) vinha do ponto de
 * entrada "core" do `swagger-ui-react`, que o Turbopack monta quebrado. Este
 * teste carrega o arquivo de verdade — se o apelido sumir de vitest.config.ts,
 * ou o pacote deixar de trazer o bundle, ele reprova. O apelido de produção é o
 * de next.config.ts, conferido abaixo por leitura.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("swagger-ui-pronto", () => {
  it("o bundle pré-montado carrega e exporta a função SwaggerUIBundle", { timeout: 60_000 }, async () => {
    const modulo = (await import("swagger-ui-pronto")) as unknown as { default?: unknown };
    const fn = (modulo.default as { default?: unknown } | undefined)?.default ?? modulo.default;

    expect(typeof fn).toBe("function");
  });

  it("next.config.ts aponta o apelido para o bundle pré-montado, não para o core", () => {
    const config = readFileSync("next.config.ts", "utf8");

    expect(config).toMatch(
      /"swagger-ui-pronto":\s*"\.\/node_modules\/swagger-ui-react\/swagger-ui-bundle\.js"/,
    );
  });

  it("a tela não importa o componente swagger-ui-react (que puxa o core quebrado)", () => {
    const tela = readFileSync("app/app/docs/_components/SwaggerDaApi.tsx", "utf8");

    expect(tela).not.toMatch(/from\s+"swagger-ui-react"/);
    expect(tela).not.toMatch(/import\(\s*"swagger-ui-react"\s*\)/);
  });
});
