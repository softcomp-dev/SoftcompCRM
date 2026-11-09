"use client";

/**
 * O Swagger UI da API, carregado só no navegador e só nesta tela.
 *
 * Três escolhas, cada uma com motivo:
 *
 * - `persistAuthorization` desligado: o token colado em "Authorize" fica só na
 *   memória da aba. Guardá-lo no localStorage deixaria um `dsk_…` com poder de
 *   escrita no navegador de quem só quis testar uma rota.
 * - `credentials: "omit"` em toda chamada do "Testar": sem isso o navegador
 *   mandaria junto o cookie da sessão, e a rota responderia como a PESSOA
 *   logada — o teste diria "funciona" para uma chamada que, vinda do ERP só com
 *   o token, recebe 401 ou 403. Omitindo, o teste mede o que o integrador vai
 *   ver.
 * - Fundo claro fixo: o Swagger UI não tem tema escuro, e o texto dele some
 *   sobre o fundo do tema escuro do CRM.
 */
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

export function SwaggerDaApi({ url }: { url: string }) {
  const t = useT();
  return (
    <div
      className="min-h-[60vh] rounded-lg border bg-white text-neutral-900"
      aria-label={t("Documentação da API")}
    >
      <SwaggerUI
        url={url}
        docExpansion="list"
        defaultModelsExpandDepth={0}
        persistAuthorization={false}
        requestInterceptor={semCookieDaSessao}
      />
    </div>
  );
}
