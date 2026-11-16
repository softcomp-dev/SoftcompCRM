"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useWinPartialLead } from "@/hooks/kanban/useUpdateLead";
import { recusaDoValorParcial, valorPrevistoCents } from "@/lib/leads/ganho-parcial";
import { formatCents, MOEDA_PADRAO, parseReaisToCents, simboloDaMoeda } from "@/lib/money";
import type { Lead } from "@/lib/types/leads";

interface PartialWinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelineId: string;
  lead: Pick<
    Lead,
    "id" | "title" | "value_cents" | "currency" | "is_partial_win" | "partial_original_value_cents"
  >;
}

const MAX_LEN = 500;

/**
 * GANHO PARCIAL — o negócio fechou com menos do que se previa.
 *
 * Pede o valor efetivamente fechado e o motivo (os dois obrigatórios). A
 * recusa do valor é a MESMA regra do servidor (`lib/leads/ganho-parcial.ts`),
 * então a tela avisa antes do clique o que a rota recusaria depois.
 */
export function PartialWinDialog({ open, onOpenChange, pipelineId, lead }: PartialWinDialogProps) {
  const t = useT();
  const moeda = lead.currency ?? MOEDA_PADRAO;
  const [valor, setValor] = useState("");
  const [motivo, setMotivo] = useState("");
  const mutation = useWinPartialLead(pipelineId);

  const previsto = valorPrevistoCents(lead);
  const valorCents = parseReaisToCents(valor, moeda);
  const recusa = valor.trim() === "" ? null : recusaDoValorParcial(lead, valorCents ?? 0);
  const motivoLimpo = motivo.trim();
  const disabled =
    valorCents == null ||
    recusa != null ||
    motivoLimpo.length === 0 ||
    motivoLimpo.length > MAX_LEN ||
    mutation.isPending;

  const handleSubmit = async () => {
    if (disabled || valorCents == null) return;
    try {
      await mutation.mutateAsync({ leadId: lead.id, valueCents: valorCents, reason: motivoLimpo });
      setValor("");
      setMotivo("");
      onOpenChange(false);
    } catch {
      // erro já mostrado pelo toast do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("Marcar como ganho parcial")}</DialogTitle>
          <DialogDescription>
            <span className="mb-1 block font-medium">{lead.title}</span>
            {t("O negócio conta como venda, com o valor que foi efetivamente fechado.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="partial-win-value">
              {t("Valor fechado")} ({simboloDaMoeda(moeda)})
            </Label>
            <Input
              id="partial-win-value"
              inputMode="decimal"
              placeholder="0,00"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              aria-invalid={recusa != null}
            />
            {previsto != null && (
              <p className="text-xs text-text-muted">
                {t("Previsto")}: {formatCents(previsto, moeda)}
              </p>
            )}
            {recusa === "sem_valor" && (
              <p role="alert" className="text-xs text-error-fg">
                {t("Informe o valor efetivamente fechado.")}
              </p>
            )}
            {recusa === "nao_e_menor_que_o_previsto" && (
              <p role="alert" className="text-xs text-error-fg">
                {t("No ganho parcial o valor fechado precisa ser menor que o previsto.")}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="partial-win-reason">{t("Motivo")}</Label>
            <Textarea
              id="partial-win-reason"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={t("Ex.: o cliente levou só parte do pedido")}
              maxLength={MAX_LEN}
              rows={3}
            />
            <div className="text-right text-[11px] tabular-nums text-text-muted">
              {motivo.length}/{MAX_LEN}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? t("Salvando...") : t("Confirmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
