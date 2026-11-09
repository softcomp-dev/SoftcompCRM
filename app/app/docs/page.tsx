/**
 * /app/docs — a documentação da API (Swagger), dentro do CRM.
 *
 * Só para quem está logado (decisão do dono da instalação). Qualquer papel lê:
 * ler a especificação não dá acesso a nada — cada rota segue exigindo o token e
 * o escopo dela. `/docs` redireciona para cá (`app/docs/page.tsx`).
 *
 * A especificação vem de `/app/docs/openapi.json`, com a marca e o endereço
 * desta instalação (`lib/api/documentacao.ts`).
 */
import Link from "next/link";

import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { SwaggerDaApi } from "./_components/SwaggerDaApi";

export const dynamic = "force-dynamic";

export default async function DocumentacaoDaApiPage() {
  const user = await requireAuth();
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Documentação da API", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Rotas que um sistema externo, como um ERP, chama com um token.", idioma)}{" "}
          {traduzir("Para testar uma rota, crie o token em", idioma)}{" "}
          <Link href="/app/settings/api-tokens" className="underline underline-offset-2">
            API Tokens
          </Link>{" "}
          {traduzir("e cole no botão Authorize.", idioma)}{" "}
          <a href="/app/docs/openapi.json" download="openapi.json" className="underline underline-offset-2">
            {traduzir("Baixar a especificação (JSON)", idioma)}
          </a>
        </p>
      </header>
      <SwaggerDaApi url="/app/docs/openapi.json" />
    </div>
  );
}
