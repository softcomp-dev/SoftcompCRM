"use client";
import { useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRegistrarInteracao } from "@/hooks/atendimento/useHistoricoDeAtendimento";
import { useT } from "@/hooks/i18n/useT";
import { randomId } from "@/lib/random-id";
import type { NegocioDoContato } from "@/lib/atendimento/historico";
import {
  CANAIS_DE_REGISTRO,
  DESFECHOS,
  DIRECOES,
  DURACAO_MAXIMA_MINUTOS,
  RESUMO_MAXIMO,
  type CanalDeRegistro,
  type Desfecho,
  type Direcao,
} from "@/lib/atendimento/interacao-manual";

import { OPCAO_DE_CANAL, OPCAO_DE_DESFECHO, ROTULO_DA_DIRECAO } from "./rotulos";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  leads: NegocioDoContato[];
}

/**
 * O negócio que já vem marcado: o aberto com movimento mais recente, como o
 * roteador de atividades faz (`lib/leads/active-lead.ts`). Sem aberto, o mais
 * recente de todos — falar com um cliente perdido também é histórico.
 */
export function negocioPadrao(leads: NegocioDoContato[]): string {
  const movimento = (l: NegocioDoContato) => Date.parse(l.last_activity_at ?? l.created_at);
  const abertos = leads.filter((l) => l.status === "open").sort((a, b) => movimento(b) - movimento(a));
  return abertos[0]?.id ?? leads[0]?.id ?? "";
}

const agoraNoCampo = () => format(new Date(), "yyyy-MM-dd'T'HH:mm");

/**
 * "Registrar interação" — a TELA de `POST /api/v1/contacts/[id]/atendimentos`.
 *
 * O que aconteceu dentro do CRM (chat, ligação pelo CRM) já entra sozinho no
 * histórico; este diálogo é para o que aconteceu fora dele. Por isso as opções
 * de canal são só as de fora, e o texto do topo diz isso — senão o vendedor
 * registra à mão a ligação que o CRM já gravou, e ela aparece duas vezes.
 */
export function RegistrarInteracaoDialog({ open, onOpenChange, contactId, leads }: Props) {
  const t = useT();
  const registrar = useRegistrarInteracao(contactId);

  const [leadId, setLeadId] = useState(() => negocioPadrao(leads));
  const [canal, setCanal] = useState<CanalDeRegistro>("phone");
  const [direcao, setDirecao] = useState<Direcao>("outbound");
  const [desfecho, setDesfecho] = useState<Desfecho>("talked");
  const [quando, setQuando] = useState(agoraNoCampo);
  const [duracao, setDuracao] = useState("");
  const [resumo, setResumo] = useState("");
  const [chave, setChave] = useState(() => randomId());
  const [dataNoFuturo, setDataNoFuturo] = useState(false);
  // O teto do campo é o instante em que o diálogo abriu: ler o relógio a cada
  // renderização deixaria a tela instável (react-hooks/purity).
  const [tetoDoCampo] = useState(agoraNoCampo);

  const limpar = () => {
    setLeadId(negocioPadrao(leads));
    setCanal("phone");
    setDirecao("outbound");
    setDesfecho("talked");
    setQuando(agoraNoCampo());
    setDuracao("");
    setResumo("");
    setChave(randomId());
    setDataNoFuturo(false);
  };

  const minutos = duracao.trim() === "" ? undefined : Number(duracao);
  const duracaoInvalida =
    minutos !== undefined && (!Number.isInteger(minutos) || minutos < 0 || minutos > DURACAO_MAXIMA_MINUTOS);
  const instante = quando ? new Date(quando) : null;
  const quandoInvalido = !instante || Number.isNaN(instante.getTime());
  const disabled =
    !leadId || resumo.trim() === "" || duracaoInvalida || quandoInvalido || registrar.isPending;

  const enviar = async () => {
    if (disabled || !instante) return;
    // A data no futuro é checada no clique, onde ler o relógio é permitido.
    if (instante.getTime() > Date.now() + 60_000) {
      setDataNoFuturo(true);
      return;
    }
    setDataNoFuturo(false);
    try {
      await registrar.mutateAsync({
        chave,
        input: {
          lead_id: leadId,
          channel: canal,
          direction: direcao,
          outcome: desfecho,
          summary: resumo.trim(),
          occurred_at: instante.toISOString(),
          ...(minutos !== undefined ? { duration_minutes: minutos } : {}),
        },
      });
      toast.success(t("Interação registrada no histórico."));
      limpar();
      onOpenChange(false);
    } catch {
      // o erro já virou toast no hook
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Registrar interação")}</DialogTitle>
          <DialogDescription>
            {t(
              "Para o contato que aconteceu fora do CRM: ligação do celular, reunião, visita, e-mail. Conversas e ligações feitas pelo CRM já entram sozinhas no histórico.",
            )}
          </DialogDescription>
        </DialogHeader>

        {leads.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {t("Este contato ainda não tem negócio. Crie um negócio para ele no funil e registre a interação nele.")}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="interacao-negocio">{t("Negócio")}</Label>
              <Select value={leadId} onValueChange={setLeadId}>
                <SelectTrigger id="interacao-negocio" aria-label={t("Negócio")}>
                  <SelectValue placeholder={t("Escolha o negócio")} />
                </SelectTrigger>
                <SelectContent>
                  {leads.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.pipeline_name ? `${l.title} · ${l.pipeline_name}` : l.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="interacao-canal">{t("Como foi")}</Label>
                <Select value={canal} onValueChange={(v) => setCanal(v as CanalDeRegistro)}>
                  <SelectTrigger id="interacao-canal" aria-label={t("Como foi")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CANAIS_DE_REGISTRO.map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(OPCAO_DE_CANAL[c])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="interacao-direcao">{t("Quem procurou")}</Label>
                <Select value={direcao} onValueChange={(v) => setDirecao(v as Direcao)}>
                  <SelectTrigger id="interacao-direcao" aria-label={t("Quem procurou")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIRECOES.map((d) => (
                      <SelectItem key={d} value={d}>
                        {t(ROTULO_DA_DIRECAO[d])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="interacao-desfecho">{t("Resultado")}</Label>
                <Select value={desfecho} onValueChange={(v) => setDesfecho(v as Desfecho)}>
                  <SelectTrigger id="interacao-desfecho" aria-label={t("Resultado")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DESFECHOS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {t(OPCAO_DE_DESFECHO[d])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="interacao-quando">{t("Quando")}</Label>
                <Input
                  id="interacao-quando"
                  type="datetime-local"
                  value={quando}
                  max={tetoDoCampo}
                  onChange={(e) => setQuando(e.target.value)}
                  aria-invalid={quandoInvalido || dataNoFuturo}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="interacao-duracao">{t("Duração em minutos (opcional)")}</Label>
                <Input
                  id="interacao-duracao"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={DURACAO_MAXIMA_MINUTOS}
                  value={duracao}
                  onChange={(e) => setDuracao(e.target.value)}
                  aria-invalid={duracaoInvalida}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="interacao-resumo">{t("O que foi conversado")}</Label>
              <Textarea
                id="interacao-resumo"
                rows={4}
                maxLength={RESUMO_MAXIMO}
                value={resumo}
                onChange={(e) => setResumo(e.target.value)}
                placeholder={t("Ex.: liguei para confirmar o orçamento; ele pediu para retornar na sexta.")}
              />
            </div>
            {dataNoFuturo ? (
              <p className="text-sm text-destructive" role="alert">
                {t("A data não pode estar no futuro.")}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={registrar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={enviar} disabled={disabled || leads.length === 0}>
            {registrar.isPending ? t("Registrando…") : t("Registrar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
