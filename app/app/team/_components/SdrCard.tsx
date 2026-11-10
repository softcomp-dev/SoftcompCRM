"use client";
/**
 * Cartão "Função SDR" da aba Membros — o interruptor por empresa
 * (`settings.sdr.enabled`, docs/features/sdr.md) e o fluxo de distribuição
 * que vale AGORA.
 *
 * Os dois fluxos: sem SDR ativo, os leads novos vão para a equipe inteira (o de
 * sempre); com SDR ativo, só para os SDRs. Quem decide é o servidor
 * (`lib/sdr/distribuicao.ts`, devolvido em `distribution`): o cartão só diz o
 * que ele respondeu, para o admin nunca ver aqui um fluxo que o rodízio não
 * pratica.
 *
 * Admin liga e desliga; gerente só lê o estado (a rota de escrita é admin).
 * Desligar não desmarca ninguém: as marcas voltam ao religar.
 */
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { useSdrSettings, useToggleSdr } from "@/hooks/sdr/useSdr";
import { useRoutingConfig } from "@/hooks/team/useAttendants";
import { Switch } from "@/components/ui/switch";

export function SdrCard({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { data, isLoading, isError } = useSdrSettings();
  const routing = useRoutingConfig();
  const toggle = useToggleSdr();
  const enabled = data?.data?.enabled === true;
  const fluxo = data?.data?.distribution;
  const modoManual = routing.data?.data?.mode === "manual";

  return (
    <section
      aria-labelledby="sdr-card-titulo"
      className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="sdr-card-titulo" className="text-base font-semibold">
          {t("Função SDR")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Marque quem faz a pré-venda: prospecta, qualifica e passa o lead pronto ao closer. Atendentes, gerentes e administradores podem ser SDR; quem tem o papel Somente leitura, não.",
          )}
        </p>
        {isError ? (
          <p className="text-sm text-destructive">{t("Não foi possível carregar a função SDR.")}</p>
        ) : isLoading ? null : (
          <p className="text-sm" data-testid="sdr-fluxo">
            {!enabled
              ? t("Leads novos: para toda a equipe, como sempre. Ligue a função para mandá-los só aos SDRs.")
              : fluxo?.flow === "sdr"
                ? t(
                    "Leads novos: só para os SDRs ativos ({n}). Se todos estiverem ocupados ou fora do horário, o lead espera um SDR.",
                  ).replace("{n}", () => String(fluxo.active_sdrs))
                : t("Nenhum SDR ativo ainda: os leads novos seguem para toda a equipe. Marque ao menos um SDR na tabela abaixo.")}
          </p>
        )}
        {enabled && modoManual ? (
          <p className="text-sm text-muted-foreground" data-testid="sdr-modo-manual">
            {t(
              "A distribuição automática está no modo manual: nenhum lead novo é entregue sozinho, a SDR ou não, salvo números com regra própria.",
            )}{" "}
            <Link href="/app/settings/atendimento" className="underline underline-offset-2">
              {t("Mudar em Configurações › Atendimento")}
            </Link>
          </p>
        ) : null}
        {enabled ? (
          <p className="text-sm text-muted-foreground">
            {t("Desligar não desmarca ninguém: as marcas voltam quando a função for religada.")}
          </p>
        ) : null}
      </div>
      {canManage ? (
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            disabled={isLoading || isError || toggle.isPending}
            onCheckedChange={(v) => toggle.mutate(v)}
            aria-label={t("Função SDR nesta empresa")}
          />
          {enabled ? t("Ligada") : t("Desligada")}
        </label>
      ) : (
        <span className="shrink-0 text-sm text-muted-foreground">
          {isLoading ? t("Carregando…") : enabled ? t("Ligada") : t("Desligada")}
        </span>
      )}
    </section>
  );
}
