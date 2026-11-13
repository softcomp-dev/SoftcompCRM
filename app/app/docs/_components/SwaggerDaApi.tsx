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

/**
 * Exportada para teste: o "Testar" chama o endereço em que a página ESTÁ
 * aberta. O servidor preenche `servers` com `NEXT_PUBLIC_APP_URL`, e quando a
 * pessoa abre a instalação por outro endereço (www, IP, domínio antigo, ou a
 * variável ainda no padrão `localhost`) a chamada sairia para outra origem e
 * morreria em "Failed to fetch", sem pista do motivo.
 */
export function naOrigemDaPagina(
  spec: Record<string, unknown>,
  origem: string,
): Record<string, unknown> {
  if (!/^https?:\/\//.test(origem)) return spec;
  return { ...spec, servers: [{ url: origem.replace(/\/+$/, ""), description: "Esta instalação" }] };
}

/**
 * Exportada para teste: a frase do erro, pelo motivo. Sessão expirada se
 * resolve entrando de novo; documentação fora da instalação não se resolve
 * recarregando, e mandar a pessoa recarregar era mandá-la girar em falso.
 */
export function fraseDoErro(motivo: string): string {
  if (motivo === "http_401" || motivo === "http_403" || motivo === "resposta_nao_json") {
    return "Sua sessão expirou. Entre de novo para ver a documentação.";
  }
  return "A documentação da API não está disponível nesta instalação. Avise quem opera o sistema.";
}

type Fase = "carregando" | "pronto" | "erro";

export function SwaggerDaApi({ url }: { url: string }) {
  const t = useT();
  const alvo = useRef<HTMLDivElement>(null);
  const [fase, setFase] = useState<Fase>("carregando");
  const [motivo, setMotivo] = useState("");

  useEffect(() => {
    let vivo = true;
    const no = alvo.current;
    carregarEspecificacao(url)
      .then((spec) => {
        if (!vivo || !no) return;
        return montarSwagger(no, {
          spec: naOrigemDaPagina(spec, window.location.origin),
          docExpansion: "list",
          defaultModelsExpandDepth: 0,
          persistAuthorization: false,
          requestInterceptor: semCookieDaSessao,
        }).then(() => vivo && setFase("pronto"));
      })
      .catch((erro: unknown) => {
        if (!vivo) return;
        setMotivo(erro instanceof Error ? erro.message : "");
        setFase("erro");
      });
    return () => {
      vivo = false;
      if (no) no.innerHTML = "";
    };
  }, [url]);

  return (
    <>
      {fase === "erro" && (
        <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
          {t(fraseDoErro(motivo))}
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
