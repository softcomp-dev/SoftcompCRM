"use client";

/**
 * O Swagger UI da API, carregado só no navegador e só nesta tela.
 *
 * Cinco escolhas, cada uma com motivo:
 *
 * - O Swagger é o PRÉ-MONTADO (`montarSwagger`, apelido `swagger-ui-pronto`),
 *   não o componente `swagger-ui-react`: no navegador o componente puxa a
 *   versão "core", que importa o leitor de OpenAPI 3.1 (ApiDOM) solto, e o
 *   Turbopack o monta quebrado (`OpenApi3_1Element.refract is not a function`)
 *   — na v1.104.4 toda operação aberta ficava girando para sempre.
 * - A ESPECIFICAÇÃO é baixada aqui, COM a sessão (`carregarEspecificacao`), e
 *   entregue pronta (`spec`, não `url`). Ela só é servida a quem está logado;
 *   na v1.104.3 o Swagger a baixava passando pelo interceptor abaixo, que tira
 *   o cookie, e recebia a tela de login ("Parser error").
 * - `credentials: "omit"` em toda chamada do "Testar": sem isso o navegador
 *   mandaria junto o cookie da sessão, e a rota responderia como a PESSOA
 *   logada — o teste diria "funciona" para uma chamada que, vinda do ERP só com
 *   o token, recebe 401 ou 403.
 * - `persistAuthorization` desligado: o token colado em "Authorize" fica só na
 *   memória da aba, nunca no localStorage.
 * - Fundo claro fixo: o Swagger UI não tem tema escuro.
 */
import { useEffect, useRef, useState } from "react";
import "swagger-ui-react/swagger-ui.css";

import { useT } from "@/hooks/i18n/useT";

import { montarSwagger } from "./montarSwagger";

interface Requisicao {
  credentials?: RequestCredentials;
  [chave: string]: unknown;
}

/** Exportada para teste: a chamada do "Testar" nunca leva o cookie da sessão. */
export function semCookieDaSessao<T extends Requisicao>(req: T): T {
  req.credentials = "omit";
  return req;
}

/**
 * Exportada para teste: baixa a especificação COM a sessão e só aceita JSON.
 * Uma resposta que não é JSON (a página de login, quando a sessão expirou) vira
 * erro com motivo, em vez de chegar ao Swagger e virar "Parser error".
 */
export async function carregarEspecificacao(
  url: string,
  buscar: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const res = await buscar(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
  const tipo = res.headers.get("content-type") ?? "";
  if (!res.ok || !tipo.includes("application/json")) {
    throw new Error(res.ok ? "resposta_nao_json" : `http_${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

type Fase = "carregando" | "pronto" | "erro";

export function SwaggerDaApi({ url }: { url: string }) {
  const t = useT();
  const alvo = useRef<HTMLDivElement>(null);
  const [fase, setFase] = useState<Fase>("carregando");

  useEffect(() => {
    let vivo = true;
    const no = alvo.current;
    carregarEspecificacao(url)
      .then((spec) => {
        if (!vivo || !no) return;
        return montarSwagger(no, {
          spec,
          docExpansion: "list",
          defaultModelsExpandDepth: 0,
          persistAuthorization: false,
          requestInterceptor: semCookieDaSessao,
        }).then(() => vivo && setFase("pronto"));
      })
      .catch(() => vivo && setFase("erro"));
    return () => {
      vivo = false;
      if (no) no.innerHTML = "";
    };
  }, [url]);

  return (
    <>
      {fase === "erro" && (
        <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
          {t("Não consegui carregar a documentação. Recarregue a página; se a sessão expirou, entre de novo.")}
        </p>
      )}
      {fase === "carregando" && <p className="p-4 text-sm text-muted-foreground">{t("Carregando…")}</p>}
      <div
        ref={alvo}
        hidden={fase === "erro"}
        className="min-h-[60vh] rounded-lg border bg-white text-neutral-900"
        aria-label={t("Documentação da API")}
        aria-busy={fase === "carregando"}
      />
    </>
  );
}
