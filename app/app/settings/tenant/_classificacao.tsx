"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  atualizarClassificacaoDeClientes,
  type PrazosDeClassificacao,
} from "@/app/actions/settings/atualizarClassificacaoDeClientes";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import { DIAS_MAXIMO, DIAS_MINIMO } from "@/lib/clientes/classificacao";

/**
 * Os prazos da classificação de clientes (migration 9257). A faixa sai da data
 * da última venda ganha do contato:
 *
 *   até `ativoDias`         → Ativo
 *   até `preInativoDias`    → Pré-inativo (a Central avisa quando o cliente entra aqui)
 *   depois disso            → Inativo
 */
export function ClassificacaoDeClientesForm({ inicial }: { inicial: PrazosDeClassificacao }) {
  const t = useT();
  const [ativo, setAtivo] = useState(String(inicial.ativoDias));
  const [preInativo, setPreInativo] = useState(String(inicial.preInativoDias));
  const [isPending, startTransition] = useTransition();

  const ativoN = Number(ativo);
  const preN = Number(preInativo);
  const dentroDaFaixa = (n: number) => Number.isInteger(n) && n >= DIAS_MINIMO && n <= DIAS_MAXIMO;
  const valido = dentroDaFaixa(ativoN) && dentroDaFaixa(preN) && preN > ativoN;

  function salvar() {
    if (!valido) return;
    startTransition(async () => {
      const r = await atualizarClassificacaoDeClientes({ ativoDias: ativoN, preInativoDias: preN });
      if (r.ok) {
        toast.success(t("Prazos da classificação salvos."));
        return;
      }
      if (r.error === "mfa_required") return irAoDesafioDeMfa();
      toast.error(t("Não foi possível salvar os prazos da classificação."));
    });
  }

  return (
    <Card className="space-y-3 p-4" data-testid="classificacao-de-clientes">
      <h2 className="text-sm font-medium">{t("Classificação de clientes")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "A classificação conta os dias desde a última venda ganha do cliente. Quando ele passa a pré-inativo, a Central avisa para a equipe agir antes que vire inativo.",
        )}
      </p>
      <div className="flex flex-wrap gap-4">
        <label className="text-sm max-md:w-full">
          {t("Ativo até (dias)")}
          <Input
            type="number"
            inputMode="numeric"
            min={DIAS_MINIMO}
            max={DIAS_MAXIMO}
            value={ativo}
            onChange={(e) => setAtivo(e.target.value)}
            className="mt-1 w-32 max-md:w-full"
            data-testid="classificacao-ativo-dias"
          />
        </label>
        <label className="text-sm max-md:w-full">
          {t("Pré-inativo até (dias)")}
          <Input
            type="number"
            inputMode="numeric"
            min={DIAS_MINIMO}
            max={DIAS_MAXIMO}
            value={preInativo}
            onChange={(e) => setPreInativo(e.target.value)}
            className="mt-1 w-32 max-md:w-full"
            data-testid="classificacao-pre-inativo-dias"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {valido
          ? t("Depois de {n} dias sem nova venda ganha, o cliente fica inativo.").replace("{n}", String(preN))
          : t("O prazo de pré-inativo precisa ser maior que o de ativo.")}
      </p>
      <Button type="button" size="sm" disabled={isPending || !valido} onClick={salvar}>
        {t("Salvar prazos")}
      </Button>
    </Card>
  );
}
