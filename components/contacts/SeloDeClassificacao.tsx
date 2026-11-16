"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DA_CLASSIFICACAO, type Classificacao } from "@/lib/clientes/classificacao";

/**
 * O selo da classificação do cliente (ativo, pré-inativo, inativo, sem compra).
 *
 * A classificação vem PRONTA da API (`contact.classificacao`), calculada no
 * servidor com os prazos da organização — a tela não refaz a conta, para que o
 * selo e o filtro nunca discordem. Sem o campo, não desenha nada.
 */
const VARIANTE: Record<Classificacao, "success" | "warning" | "error" | "outline"> = {
  ativo: "success",
  pre_inativo: "warning",
  inativo: "error",
  sem_compra: "outline",
};

export function SeloDeClassificacao({
  classificacao,
  ultimaVenda,
}: {
  classificacao: Classificacao | undefined;
  ultimaVenda?: string | null;
}) {
  const t = useT();
  if (!classificacao) return null;
  const dica = ultimaVenda
    ? `${t("Última venda ganha:")} ${new Date(ultimaVenda).toLocaleDateString()}`
    : t("Nenhuma venda ganha");
  return (
    <Badge variant={VARIANTE[classificacao]} title={dica} data-testid={`classificacao-${classificacao}`}>
      {t(ROTULO_DA_CLASSIFICACAO[classificacao])}
    </Badge>
  );
}
