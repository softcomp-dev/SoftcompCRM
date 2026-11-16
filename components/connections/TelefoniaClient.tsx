"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Phone, Plus } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import {
  useCreatePhoneNumber,
  usePhoneNumbers,
  useUpdatePhoneNumber,
  type PhoneNumberRow,
} from "@/hooks/telefonia/usePhoneNumbers";
import type { RoutingMode } from "@/lib/schemas/phone-numbers";

/** Sentinela do Select — Radix rejeita `value=""` num SelectItem. */
const SEM_AGENTE = "__none__";

interface VoiceAgentOption {
  agent_id: string;
  name: string;
}

function useVoiceAgents() {
  return useQuery({
    queryKey: ["ai-agents-assignable", "voice"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: VoiceAgentOption[] }>(
        "/api/v1/ai/agents/assignable?channel=voice",
      );
      return res.data;
    },
  });
}

const ROUTING_LABELS: Record<RoutingMode, string> = {
  ai: "IA responde",
  human: "Time humano",
  ai_then_human: "IA, depois time humano",
};

/**
 * O que cada modo faz, dito na tela. "Time humano" encaminha a ligação para um
 * telefone do time pelo tronco SIP; o telefone no navegador ainda não existe
 * (docs/specs/36-spec-telefonia-sip-atendimento-humano.md).
 */
const ROUTING_HINTS: Record<RoutingMode, string> = {
  ai: "O agente de voz atende todas as ligações.",
  human: "A ligação é encaminhada para o telefone do time. Se ninguém atender, vira aviso na Central.",
  ai_then_human:
    "O agente de voz atende e passa para o telefone do time quando a pessoa pede ou o assunto exige.",
};

/**
 * Cadastro de números de voz (DID) da organização — a contraparte de
 * ConnectionsClient (QR) e CanalOficialClient (Meta), mesmo padrão: uma lista
 * do que já existe + um diálogo pra adicionar. O troncal SIP (host/usuário/
 * senha do provedor) NÃO aparece aqui — é infraestrutura compartilhada da
 * plataforma, configurada uma vez só; a organização escolhe apenas o número,
 * o modo de atendimento e qual agente de voz atende.
 */
export function TelefoniaClient() {
  const t = useT();
  const telefoneExemplo = useTelefoneExemplo();
  const { data: numbers, isLoading } = usePhoneNumbers();
  const { data: voiceAgents } = useVoiceAgents();
  const createMut = useCreatePhoneNumber();
  const updateMut = useUpdatePhoneNumber();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    number: "",
    label: "",
    routing_mode: "ai" as RoutingMode,
    default_ai_agent_id: SEM_AGENTE,
    forward_to_phone: "",
  });
  const precisaDeDestino = form.routing_mode !== "ai";

  async function handleCreate() {
    const number = form.number.trim();
    if (number === "") return;
    await createMut.mutateAsync({
      number,
      label: form.label.trim() === "" ? null : form.label.trim(),
      routing_mode: form.routing_mode,
      default_ai_agent_id: form.default_ai_agent_id === SEM_AGENTE ? null : form.default_ai_agent_id,
      forward_to_phone: form.forward_to_phone.trim() === "" ? null : form.forward_to_phone.trim(),
      is_active: true,
    });
    setDialogOpen(false);
    setForm({ number: "", label: "", routing_mode: "ai", default_ai_agent_id: SEM_AGENTE, forward_to_phone: "" });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t(
            "Números que recebem ligações. Cada número aponta pra um agente de voz e um modo de atendimento.",
          )}
        </p>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus size={16} className="mr-1" />
          {t("Novo número")}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : (numbers ?? []).length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {t("Nenhum número cadastrado ainda.")}
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {(numbers ?? []).map((row) => (
            <PhoneNumberCard
              key={row.id}
              row={row}
              voiceAgents={voiceAgents ?? []}
              onUpdate={(patch) => updateMut.mutate({ id: row.id, ...patch })}
            />
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Novo número")}</DialogTitle>
            <DialogDescription>
              {t(
                "Cadastre o número (DID) que vai receber ligações. O troncal de voz já está configurado pela plataforma.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="space-y-1">
              <Label>{t("Número (E.164)")}</Label>
              <Input
                placeholder={telefoneExemplo}
                value={form.number}
                onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("Rótulo (opcional)")}</Label>
              <Input
                placeholder={t("Ex.: Linha principal")}
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("Modo de atendimento")}</Label>
              <Select
                value={form.routing_mode}
                onValueChange={(v) => setForm((f) => ({ ...f, routing_mode: v as RoutingMode }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROUTING_LABELS) as RoutingMode[]).map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(ROUTING_LABELS[v])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(ROUTING_HINTS[form.routing_mode])}</p>
            </div>
            {precisaDeDestino && (
              <div className="space-y-1">
                <Label htmlFor="telefone-do-time">{t("Telefone do time")}</Label>
                <Input
                  id="telefone-do-time"
                  placeholder={telefoneExemplo}
                  value={form.forward_to_phone}
                  onChange={(e) => setForm((f) => ({ ...f, forward_to_phone: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Celular ou fixo de quem atende. A ligação é discada pelo mesmo tronco SIP.")}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t("Agente de voz")}</Label>
              <Select
                value={form.default_ai_agent_id}
                onValueChange={(v) => setForm((f) => ({ ...f, default_ai_agent_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_AGENTE}>{t("Nenhum agente")}</SelectItem>
                  {(voiceAgents ?? []).map((a) => (
                    <SelectItem key={a.agent_id} value={a.agent_id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(voiceAgents ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("Nenhum agente de voz publicado ainda — crie um em IA › Agentes.")}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("Cancelar")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                createMut.isPending ||
                form.number.trim() === "" ||
                (precisaDeDestino && form.forward_to_phone.trim() === "")
              }
            >
              {createMut.isPending ? t("Salvando…") : t("Cadastrar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PhoneNumberCard({
  row,
  voiceAgents,
  onUpdate,
}: {
  row: PhoneNumberRow;
  voiceAgents: VoiceAgentOption[];
  onUpdate: (patch: {
    label?: string | null;
    routing_mode?: RoutingMode;
    default_ai_agent_id?: string | null;
    forward_to_phone?: string | null;
    is_active?: boolean;
  }) => void;
}) {
  const t = useT();
  // Modo escolhido que ainda espera o telefone do time: o PATCH só sai quando
  // os dois estão prontos (a rota recusa modo humano sem destino).
  const [modoPendente, setModoPendente] = useState<RoutingMode | null>(null);
  const [destino, setDestino] = useState(row.forward_to_phone ?? "");
  const modoNaTela = modoPendente ?? row.routing_mode;
  const pedeDestino = modoNaTela !== "ai";

  function escolherModo(v: RoutingMode) {
    if (v !== "ai" && !(row.forward_to_phone ?? "").trim()) {
      setModoPendente(v);
      return;
    }
    setModoPendente(null);
    onUpdate({ routing_mode: v });
  }

  function salvarDestino() {
    const valor = destino.trim();
    if (modoPendente) {
      if (valor === "") return;
      onUpdate({ routing_mode: modoPendente, forward_to_phone: valor });
      setModoPendente(null);
      return;
    }
    if (valor !== (row.forward_to_phone ?? "") && valor !== "") onUpdate({ forward_to_phone: valor });
  }

  return (
    <Card className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <Phone size={20} className="text-muted-foreground" />
        <div>
          <p className="font-medium">{row.number}</p>
          <p className="text-xs text-muted-foreground">{row.label ?? t("Sem rótulo")}</p>
        </div>
        <Badge variant={row.is_active ? "default" : "outline"}>
          {row.is_active ? t("Ativo") : t("Inativo")}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={modoNaTela} onValueChange={(v) => escolherModo(v as RoutingMode)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROUTING_LABELS) as RoutingMode[]).map((v) => (
              <SelectItem key={v} value={v}>
                {t(ROUTING_LABELS[v])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={row.default_ai_agent_id ?? SEM_AGENTE}
          onValueChange={(v) => onUpdate({ default_ai_agent_id: v === SEM_AGENTE ? null : v })}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SEM_AGENTE}>{t("Nenhum agente")}</SelectItem>
            {voiceAgents.map((a) => (
              <SelectItem key={a.agent_id} value={a.agent_id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {pedeDestino && (
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("Telefone do time")}
              placeholder={t("Telefone do time")}
              className="w-44"
              value={destino}
              onChange={(e) => setDestino(e.target.value)}
              onBlur={modoPendente ? undefined : salvarDestino}
            />
            {modoPendente && (
              <Button size="sm" onClick={salvarDestino} disabled={destino.trim() === ""}>
                {t("Salvar")}
              </Button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Switch
            checked={row.is_active}
            onCheckedChange={(v) => onUpdate({ is_active: v })}
            id={`ativo-${row.id}`}
          />
          <Label htmlFor={`ativo-${row.id}`} className="text-xs">
            {t("Ativo")}
          </Label>
        </div>
      </div>
    </Card>
  );
}
