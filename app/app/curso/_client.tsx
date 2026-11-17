"use client";

import { useT } from "@/hooks/i18n/useT";
import { enderecoDoCurso } from "@/lib/curso/endereco";
import { ArrowSquareOut } from "@/lib/ui/icons";

export function CursoConteudo({ base }: { base: string }) {
  const t = useT();
  // O curso é só em português (lib/curso/endereco.ts): o mesmo endereço para
  // qualquer idioma da interface.
  const endereco = enderecoDoCurso(base);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Curso")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Aulas com a foto de cada tela, passo a passo, e um simulador para praticar clicando.")}
          </p>
        </div>
        {endereco && (
          <a
            href={endereco}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            data-testid="curso-abrir-em-nova-aba"
          >
            {t("Abrir em nova aba")}
            <ArrowSquareOut size={14} aria-hidden />
          </a>
        )}
      </header>

      {endereco ? (
        <iframe
          src={endereco}
          title={t("Curso")}
          data-testid="curso-quadro"
          className="min-h-[70vh] w-full flex-1 rounded-lg border bg-background"
          // O curso é página estática de outra origem: roda o próprio script
          // (leitura, simulador, busca) e abre links em aba nova; não recebe a
          // sessão do CRM, porque é outra origem.
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground" data-testid="curso-indisponivel">
          {t("O curso não está disponível nesta instalação.")}
        </p>
      )}
    </div>
  );
}
