"use client";
/**
 * Cartão "Função SDR" da aba Membros — o interruptor por empresa
 * (`settings.sdr.enabled`, docs/features/sdr.md).
 *
 * Admin liga e desliga; gerente só lê o estado (a rota de escrita é admin).
 * Desligar não desmarca ninguém: a coluna SDR some da tabela, as marcas ficam
 * guardadas e voltam ao religar — o texto diz isso para o admin não ter medo
 * de desligar.
 */
import { useT } from "@/hooks/i18n/useT";
import { useSdrSettings, useToggleSdr } from "@/hooks/sdr/useSdr";
import { Switch } from "@/components/ui/switch";

export function SdrCard({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { data, isLoading, isError } = useSdrSettings();
  const toggle = useToggleSdr();
  const enabled = data?.data?.enabled === true;

  return (
    <section
      aria-labelledby="sdr-card-titulo"
      className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0">
        <h2 id="sdr-card-titulo" className="text-base font-semibold">
          {t("Função SDR")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Marque quem faz a pré-venda: prospecta, qualifica e passa o lead pronto ao closer. Atendentes, gerentes e administradores podem ser SDR; quem tem o papel Somente leitura, não.",
          )}
        </p>
        {enabled ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Desligar não desmarca ninguém: as marcas voltam quando a função for religada.")}
          </p>
        ) : null}
        {isError ? (
          <p className="mt-1 text-sm text-destructive">{t("Não foi possível carregar a função SDR.")}</p>
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
