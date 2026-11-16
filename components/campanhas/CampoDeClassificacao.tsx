"use client";

import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { CLASSIFICACOES, ROTULO_DA_CLASSIFICACAO, type Classificacao } from "@/lib/clientes/classificacao";

/**
 * O critério "Classificação do cliente" do público da campanha (migration 9257).
 * Uma faixa por vez na tela — o filtro aceita várias, e a mais pedida é uma só:
 * os pré-inativos, para reativar antes que esfriem de vez.
 */
export function CampoDeClassificacao({
  id,
  valor,
  aoMudar,
}: {
  id: string;
  valor: Classificacao | "";
  aoMudar: (v: Classificacao | "") => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("Classificação do cliente")}</Label>
      <select
        id={id}
        data-testid="campanha-classificacao"
        className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
        value={valor}
        onChange={(e) => aoMudar(e.target.value as Classificacao | "")}
      >
        <option value="">{t("Qualquer uma")}</option>
        {CLASSIFICACOES.map((faixa) => (
          <option key={faixa} value={faixa}>
            {t(ROTULO_DA_CLASSIFICACAO[faixa])}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Lê a primeira faixa válida de um `audience_filter` salvo. */
export function classificacaoDoFiltro(bruto: unknown): Classificacao | "" {
  if (!Array.isArray(bruto)) return "";
  const primeira = bruto.find((v): v is Classificacao => (CLASSIFICACOES as readonly unknown[]).includes(v));
  return primeira ?? "";
}
