/**
 * A tela /app/docs, com as duas metades que a v1.104.3 separou por engano:
 *
 * - a ESPECIFICAÇÃO é baixada COM a sessão (ela só é servida a quem está
 *   logado) e entregue pronta ao Swagger;
 * - o "Testar" sai SEM o cookie da sessão.
 *
 * Na v1.104.3 o Swagger baixava a especificação pela `url`, passando pelo
 * interceptor que tira o cookie; o proxy devolvia o login, e a tela mostrava
 * "Parser error". O caso "o Swagger recebe `spec`" é o que pega a regressão —
 * os testes da época testavam as duas metades isoladas. O Swagger em si é o
 * pré-montado (montarSwagger.test.ts); aqui ele é substituído.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const recebido: { opcoes?: Record<string, unknown> } = {};

vi.mock("./montarSwagger", () => ({
  montarSwagger: vi.fn(async (no: HTMLElement, opcoes: Record<string, unknown>) => {
    recebido.opcoes = opcoes;
    no.setAttribute("data-montado", "sim");
  }),
}));
vi.mock("swagger-ui-react/swagger-ui.css", () => ({}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import {
  SwaggerDaApi,
  carregarEspecificacao,
  fraseDoErro,
  naOrigemDaPagina,
  semCookieDaSessao,
} from "./SwaggerDaApi";

const SPEC = { openapi: "3.1.0", info: { title: "Minha Marca — API para integrações" }, paths: {} };

function resposta(corpo: string, tipo: string, status = 200): Response {
  return new Response(corpo, { status, headers: { "content-type": tipo } });
}

describe("carregarEspecificacao", () => {
  it("baixa COM a sessão (same-origin) e devolve o objeto", async () => {
    const buscar = vi.fn(async () => resposta(JSON.stringify(SPEC), "application/json"));

    const spec = await carregarEspecificacao("/app/docs/openapi.json", buscar as never);

    expect(spec).toEqual(SPEC);
    expect(buscar).toHaveBeenCalledWith(
      "/app/docs/openapi.json",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("a página de login (HTML) vira erro, não chega ao Swagger como YAML", async () => {
    const buscar = vi.fn(async () => resposta("<!doctype html><title>Entrar</title>", "text/html"));

    await expect(carregarEspecificacao("/app/docs/openapi.json", buscar as never)).rejects.toThrow(
      "resposta_nao_json",
    );
  });

  it("401 vira erro com o status", async () => {
    const buscar = vi.fn(async () => resposta("{}", "application/json", 401));

    await expect(carregarEspecificacao("/app/docs/openapi.json", buscar as never)).rejects.toThrow(
      "http_401",
    );
  });
});

describe("SwaggerDaApi", () => {
  it("entrega a especificação pronta ao Swagger, com o Testar sem cookie e o token só na aba", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(JSON.stringify(SPEC), "application/json")));
    recebido.opcoes = undefined;

    const { container } = render(<SwaggerDaApi url="/app/docs/openapi.json" />);

    await waitFor(() => expect(container.querySelector('[data-montado="sim"]')).toBeTruthy());
    const opcoes = recebido.opcoes as Record<string, unknown> | undefined;
    // A especificação chega inteira, com o servidor trocado pela origem da página.
    expect(opcoes?.spec).toEqual({
      ...SPEC,
      servers: [{ url: window.location.origin, description: "Esta instalação" }],
    });
    expect(opcoes?.url).toBeUndefined();
    expect(opcoes?.requestInterceptor).toBe(semCookieDaSessao);
    expect(opcoes?.persistAuthorization).toBe(false);
    vi.unstubAllGlobals();
  });

  it("sessão expirada → aviso legível, sem Swagger quebrado", async () => {
    recebido.opcoes = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => resposta("<html></html>", "text/html")));

    render(<SwaggerDaApi url="/app/docs/openapi.json" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(recebido.opcoes).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("naOrigemDaPagina", () => {
  it("o Testar chama o endereço em que a página está aberta, não o da variável de ambiente", () => {
    const spec = { openapi: "3.1.0", servers: [{ url: "http://localhost:3000" }], paths: { "/api/v1/leads": {} } };

    const saida = naOrigemDaPagina(spec, "https://crm.cliente.com.br/");

    expect(saida.servers).toEqual([{ url: "https://crm.cliente.com.br", description: "Esta instalação" }]);
    expect(saida.paths).toBe(spec.paths);
    // A entrada fica intacta.
    expect(spec.servers).toEqual([{ url: "http://localhost:3000" }]);
  });

  it("origem que não é http(s) (about:blank, 'null') não troca nada", () => {
    const spec = { servers: [{ url: "https://crm.exemplo.com" }] };
    expect(naOrigemDaPagina(spec, "null")).toBe(spec);
  });
});

describe("fraseDoErro", () => {
  it("sessão expirada manda entrar de novo", () => {
    for (const motivo of ["http_401", "http_403", "resposta_nao_json"]) {
      expect(fraseDoErro(motivo)).toContain("sessão expirou");
    }
  });

  it("documentação fora da instalação NÃO manda recarregar: manda avisar quem opera", () => {
    for (const motivo of ["http_500", "swagger_ui_indisponivel", ""]) {
      expect(fraseDoErro(motivo)).toContain("não está disponível");
    }
  });
});

describe("semCookieDaSessao", () => {
  it("toda chamada do Testar sai com credentials: omit, mantendo o resto", () => {
    const req = {
      url: "https://crm.exemplo.com/api/v1/leads",
      headers: { Authorization: "Bearer dsk_x" },
      credentials: "same-origin" as RequestCredentials,
    };

    const saida = semCookieDaSessao(req);

    expect(saida.credentials).toBe("omit");
    expect(saida.headers).toEqual({ Authorization: "Bearer dsk_x" });
  });
});
