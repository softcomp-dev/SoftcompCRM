"use client";

/**
 * O Swagger UI da API, carregado só no navegador e só nesta tela.
 *
 * Quatro escolhas, cada uma com motivo:
 *
 * - A ESPECIFICAÇÃO é baixada aqui, COM a sessão (`carregarEspecificacao`), e
 *   entregue pronta ao Swagger (`spec`, não `url`). Ela só é servida a quem
 *   está logado; na v1.104.3 o Swagger a baixava por conta própria, passando
 *   pelo `requestInterceptor` abaixo — que tira o cookie —, o proxy respondia
 *   com o redirecionamento para o login, e a tela mostrava "Parser error: bad
 *   indentation of a mapping entry" (o HTML do login lido como YAML).
 * - `credentials: "omit"` em toda chamada do "Testar": sem isso o navegador
 *   mandaria junto o cookie da sessão, e a rota responderia como a PESSOA
 *   logada — o teste diria "funciona" para uma chamada que, vinda do ERP só com
 *   o token, recebe 401 ou 403. Omitindo, o teste mede o que o integrador vai
 *   ver.
 * - `persistAuthorization` desligado: o token colado em "Authorize" fica só na
 *   memória da aba. Guardá-lo no localStorage deixaria um `dsk_…` com poder de
 *   escrita no navegador de quem só quis testar uma rota.
 * - Fundo claro fixo: o Swagger UI não tem tema escuro, e o texto dele some
 *   sobre o fundo do tema escuro do CRM.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

import { useT } from "@/hooks/i18n/useT";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

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

type Estado =
  | { fase: "carregando" }
  | { fase: "pronto"; spec: Record<string, unknown> }
  | { fase: "erro" };

export function SwaggerDaApi({ url }: { url: string }) {
  const t = useT();
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });

  useEffect(() => {
    let vivo = true;
    carregarEspecificacao(url)
      .then((spec) => vivo && setEstado({ fase: "pronto", spec }))
      .catch(() => vivo && setEstado({ fase: "erro" }));
    return () => {
      vivo = false;
    };
  }, [url]);

  if (estado.fase === "erro") {
    return (
      <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
        {t("Não consegui carregar a documentação. Recarregue a página; se a sessão expirou, entre de novo.")}
      </p>
    );
  }

  return (
    <div
      className="min-h-[60vh] rounded-lg border bg-white text-neutral-900"
      aria-label={t("Documentação da API")}
      aria-busy={estado.fase === "carregando"}
    >
      {estado.fase === "carregando" ? (
        <p className="p-4 text-sm text-neutral-500">{t("Carregando…")}</p>
      ) : (
        <SwaggerUI
          spec={estado.spec}
          docExpansion="list"
          defaultModelsExpandDepth={0}
          persistAuthorization={false}
          requestInterceptor={semCookieDaSessao}
        />
      )}
    </div>
  );
}
