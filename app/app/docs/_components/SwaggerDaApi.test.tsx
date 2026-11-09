/**
 * A tela /app/docs, com as duas metades que a v1.104.3 separou por engano:
 *
 * - a ESPECIFICAÇÃO é baixada COM a sessão (ela só é servida a quem está
 *   logado) e entregue pronta ao Swagger;
 * - o "Testar" sai SEM o cookie da sessão.
 *
 * Na v1.104.3 o Swagger baixava a especificação pela `url`, passando pelo
 * interceptor que tira o cookie; o proxy devolvia o login, e a tela mostrava
 * "Parser error". O caso "o Swagger recebe `spec`, não `url`" é o que pega a
 * regressão — os testes da época testavam as duas metades isoladas.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const recebido: { props?: Record<string, unknown> } = {};

vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    recebido.props = props;
    return <div data-testid="swagger" />;
  },
}));
vi.mock("swagger-ui-react/swagger-ui.css", () => ({}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { SwaggerDaApi, carregarEspecificacao, semCookieDaSessao } from "./SwaggerDaApi";

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
  it("entrega a especificação pronta (spec, não url) e o Testar sem cookie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(JSON.stringify(SPEC), "application/json")));
    recebido.props = undefined;

    render(<SwaggerDaApi url="/app/docs/openapi.json" />);

    await screen.findByTestId("swagger");
    const props = recebido.props as Record<string, unknown> | undefined;
    expect(props?.spec).toEqual(SPEC);
    expect(props?.url).toBeUndefined();
    expect(props?.requestInterceptor).toBe(semCookieDaSessao);
    expect(props?.persistAuthorization).toBe(false);
    vi.unstubAllGlobals();
  });

  it("sessão expirada → aviso legível, sem Swagger quebrado", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta("<html></html>", "text/html")));

    render(<SwaggerDaApi url="/app/docs/openapi.json" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByTestId("swagger")).toBeNull();
    vi.unstubAllGlobals();
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
