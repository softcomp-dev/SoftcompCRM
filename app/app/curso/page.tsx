import { requireAuth } from "@/lib/auth/server";
import { env } from "@/lib/env";

import { CursoConteudo } from "./_client";

/**
 * O CURSO ILUSTRADO DENTRO DO CRM.
 *
 * O curso — aulas com foto da tela, setas, caixas e simulador — é montado por
 * `curso/montar.ts` e publicado FORA da imagem do app (as fotos passam de
 * 50 MB). Esta tela abre a publicação num quadro, com o link para abrir em aba
 * própria. O curso é só em português (lib/curso/endereco.ts).
 *
 * O endereço vem de `CURSO_URL` (lib/env.ts), lido aqui no servidor; o padrão é
 * a publicação do fork. Vazio desliga, e a tela diz isso em vez de abrir um
 * quadro em branco.
 */
export const dynamic = "force-dynamic";

export default async function CursoPage() {
  await requireAuth();
  return <CursoConteudo base={env.CURSO_URL} />;
}
