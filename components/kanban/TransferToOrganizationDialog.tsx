"use client";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useTransferLeadToOrganization } from "@/hooks/kanban/useUpdateLead";
import { etapasAbertasDoDestino } from "@/hooks/kanban/useDestinosDeFunil";
import { useDestinosDeEmpresa } from "@/hooks/kanban/useDestinosDeEmpresa";

interface TransferToOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
}

/**
 * "Transferir para outra empresa" — a TELA de
 * `POST /api/v1/leads/[id]/transferir-empresa`. Regras em
 * `lib/leads/transferir-entre-empresas.ts`.
 *
 * Três escolhas em cascata, cada uma limpando as de baixo (a etapa é do funil,
 * o funil é da empresa — mandar uma escolha antiga daria 404/422 no servidor):
 * empresa → funil → etapa (opcional; sem escolha, a primeira aberta).
 *
 * A descrição diz o que vai e o que fica, porque é a pergunta que quem
 * transfere faz: as conversas são do canal da empresa de origem e ficam lá.
 */
export function TransferToOrganizationDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
}: TransferToOrganizationDialogProps) {
  const t = useT();
  const [orgId, setOrgId] = useState("");
  const [funilId, setFunilId] = useState("");
  const [etapaId, setEtapaId] = useState("");
  const mutation = useTransferLeadToOrganization(pipelineId);
  const destinos = useDestinosDeEmpresa(leadId, open);

  const empresa = (destinos.data ?? []).find((e) => e.organization_id === orgId);
  const funil = empresa?.pipelines.find((p) => p.id === funilId);
  const etapas = etapasAbertasDoDestino(funil);
  const empresaSemFunil = !!empresa && empresa.pipelines.length === 0;
  const funilSemEtapaAberta = !!funil && etapas.length === 0;

  const limpar = () => {
    setOrgId("");
    setFunilId("");
    setEtapaId("");
  };

  const disabled = !orgId || !funilId || funilSemEtapaAberta || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({
        leadId,
        organizationId: orgId,
        pipelineId: funilId,
        stageId: etapaId || null,
      });
      toast.success(
        t("Negócio transferido para {org}.").replace("{org}", empresa?.name ?? ""),
      );
      limpar();
      onOpenChange(false);
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) limpar();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Transferir para outra empresa")}</DialogTitle>
          <DialogDescription>
            {t(
              "O negócio é recriado na empresa escolhida, com o mesmo cliente (achado pelo telefone ou e-mail, ou cadastrado lá), e este encerra como transferido. As conversas, tarefas e anexos ficam nesta empresa.",
            )}
          </DialogDescription>
        </DialogHeader>

        {destinos.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        ) : destinos.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "Não há outra empresa para onde você possa transferir este negócio. É preciso ter acesso de atendente ou acima na empresa de destino.",
            )}
          </p>
        ) : (
          <Select
            value={orgId}
            onValueChange={(next) => {
              setOrgId(next);
              setFunilId("");
              setEtapaId("");
            }}
          >
            <SelectTrigger aria-label={t("Empresa de destino")}>
              <SelectValue placeholder={t("Escolha a empresa de destino")} />
            </SelectTrigger>
            <SelectContent>
              {(destinos.data ?? []).map((e) => (
                <SelectItem key={e.organization_id} value={e.organization_id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {empresaSemFunil ? (
          <p className="text-sm text-destructive" role="alert">
            {t("Esta empresa ainda não tem funil para receber o negócio.")}
          </p>
        ) : empresa ? (
          <Select
            value={funilId}
            onValueChange={(next) => {
              setFunilId(next);
              setEtapaId("");
            }}
          >
            <SelectTrigger aria-label={t("Funil de destino")}>
              <SelectValue placeholder={t("Escolha o funil de destino")} />
            </SelectTrigger>
            <SelectContent>
              {empresa.pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {funilSemEtapaAberta ? (
          <p className="text-sm text-destructive" role="alert">
            {t("Este funil não tem etapa aberta para receber o negócio. Escolha outro funil.")}
          </p>
        ) : funil ? (
          <div className="space-y-1">
            <Select value={etapaId} onValueChange={setEtapaId}>
              <SelectTrigger aria-label={t("Etapa de entrada")}>
                <SelectValue placeholder={t("Primeira etapa aberta (padrão)")} />
              </SelectTrigger>
              <SelectContent>
                {etapas.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Sem escolha, o negócio entra na primeira etapa aberta do funil.")}
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? t("Transferindo…") : t("Transferir")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
