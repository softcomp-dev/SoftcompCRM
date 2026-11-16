"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Locale } from "date-fns";
import { format, isToday, isYesterday } from "date-fns";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHistoricoDeAtendimento } from "@/hooks/atendimento/useHistoricoDeAtendimento";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type {
  CanalDoHistorico,
  ItemDoHistoricoView,
  NegocioDoContato,
  OrigemDoAtendimento,
} from "@/lib/atendimento/historico";
import {
  ChatCircle,
  EnvelopeSimple,
  MapPin,
  Phone,
  PhoneX,
  Plus,
  Robot,
  UsersThree,
  WhatsappLogo,
  ArrowSquareOut,
  ChatsCircle,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { RegistrarInteracaoDialog } from "./RegistrarInteracaoDialog";
import { ROTULO_DA_DIRECAO, ROTULO_DO_CANAL, ROTULO_DO_DESFECHO } from "./rotulos";

interface Props {
  contactId: string;
  /** `agent` ou acima: quem pode registrar. Quem só lê vê o histórico sem o botão. */
  podeRegistrar: boolean;
}

const ICONE_DO_CANAL: Record<CanalDoHistorico, PhosphorIcon> = {
  whatsapp_chat: ChatCircle,
  voip: Phone,
  whatsapp_call: WhatsappLogo,
  phone: Phone,
  whatsapp: WhatsappLogo,
  email: EnvelopeSimple,
  meeting: UsersThree,
  visit: MapPin,
  other: ChatsCircle,
};

const FILTROS = {
  todos: "Tudo",
  chat: "Conversas",
  call: "Ligações",
  record: "Registrados pela equipe",
} as const;
type Filtro = keyof typeof FILTROS;

function cabecalhoDoDia(d: Date, t: (texto: string) => string, locale: Locale): string {
  if (isToday(d)) return t("Hoje");
  if (isYesterday(d)) return t("Ontem");
  return format(d, "EEEE, dd/MM/yyyy", { locale });
}

/** A chave do grupo é o dia LOCAL; montar pelos pedaços evita a meia-noite UTC (#2934). */
function diaDaChave(chave: string): Date {
  const [ano = 0, mes = 1, dia = 1] = chave.split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

function duracaoLegivel(segundos: number, t: (texto: string) => string): string {
  if (segundos < 60) return t("{n} s").replace("{n}", String(segundos));
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return t("{n} min").replace("{n}", String(minutos));
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return t("{h} h {m} min").replace("{h}", String(horas)).replace("{m}", String(resto));
}

function nomes(item: ItemDoHistoricoView): string {
  return item.team.map((p) => p.name ?? "—").join(", ");
}

function LinhaDoHistorico({
  item,
  negocio,
  t,
  locale,
}: {
  item: ItemDoHistoricoView;
  negocio: NegocioDoContato | undefined;
  t: (texto: string) => string;
  locale: Locale;
}) {
  const Icone = item.outcome === "no_answer" && item.source !== "chat" ? PhoneX : ICONE_DO_CANAL[item.channel];
  const contagem = item.messages;
  const partes: string[] = [];
  if (contagem) {
    if (contagem.from_contact > 0) partes.push(t("{n} do cliente").replace("{n}", String(contagem.from_contact)));
    if (contagem.from_team > 0) partes.push(t("{n} da equipe").replace("{n}", String(contagem.from_team)));
    if (contagem.from_ai > 0) partes.push(t("{n} da IA").replace("{n}", String(contagem.from_ai)));
    if (contagem.automated > 0) partes.push(t("{n} automáticas").replace("{n}", String(contagem.automated)));
  }

  return (
    <li className="flex gap-3 px-4 py-3" data-testid="item-do-historico" data-source={item.source}>
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
          item.outcome === "no_answer" ? "text-muted-foreground" : "text-foreground",
        )}
        aria-hidden
      >
        <Icone className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{t(ROTULO_DO_CANAL[item.channel])}</span>
          {item.outcome ? (
            <Badge variant={item.outcome === "talked" ? "secondary" : "outline"}>
              {t(ROTULO_DO_DESFECHO[item.outcome])}
            </Badge>
          ) : null}
          {item.handled_by_ai ? (
            <Badge variant="outline" className="gap-1">
              <Robot className="size-3" aria-hidden />
              {t("Com IA")}
            </Badge>
          ) : null}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {format(new Date(item.started_at), "HH:mm", { locale })}
            {item.ended_at && item.source === "chat" && item.ended_at !== item.started_at
              ? `–${format(new Date(item.ended_at), "HH:mm", { locale })}`
              : ""}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">
          {[
            item.direction ? t(ROTULO_DA_DIRECAO[item.direction]) : null,
            item.duration_seconds !== null && item.duration_seconds > 0
              ? duracaoLegivel(item.duration_seconds, t)
              : null,
            partes.length > 0 ? partes.join(" · ") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {item.team.length > 0 ? (
          <p className="text-sm">
            <span className="text-muted-foreground">
              {item.source === "record" ? t("Registrado por") : t("Atendido por")}:
            </span>{" "}
            {nomes(item)}
          </p>
        ) : null}

        {item.summary ? <p className="whitespace-pre-wrap text-sm">{item.summary}</p> : null}

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {negocio ? (
            <span>
              {t("Negócio")}: {negocio.title}
            </span>
          ) : null}
          {item.conversation_id ? (
            <Link
              href={`/app/inbox?id=${item.conversation_id}`}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("Abrir conversa")}
              <ArrowSquareOut className="size-3" aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * A aba "Atendimentos" da ficha do contato: toda interação da equipe com o
 * cliente. O chat e as ligações feitas pelo CRM entram sozinhos; o que
 * aconteceu fora dele entra pelo botão "Registrar interação".
 */
export function HistoricoDeAtendimento({ contactId, podeRegistrar }: Props) {
  const t = useT();
  const locale = useLocaleDeData();
  const q = useHistoricoDeAtendimento(contactId);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [registrando, setRegistrando] = useState(false);

  const paginas = useMemo(() => q.data?.pages ?? [], [q.data]);
  const leads = useMemo(() => paginas[0]?.data.leads ?? [], [paginas]);
  const negocioPorId = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);

  const grupos = useMemo(() => {
    const todos = paginas.flatMap((p) => p.data.items);
    const visiveis = filtro === "todos" ? todos : todos.filter((i) => i.source === (filtro as OrigemDoAtendimento));
    const porDia = new Map<string, ItemDoHistoricoView[]>();
    for (const item of visiveis) {
      const chave = format(new Date(item.started_at), "yyyy-MM-dd");
      const lista = porDia.get(chave);
      if (lista) lista.push(item);
      else porDia.set(chave, [item]);
    }
    return [...porDia.entries()];
  }, [paginas, filtro]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("Filtrar histórico")}>
          {(Object.keys(FILTROS) as Filtro[]).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filtro === f ? "secondary" : "ghost"}
              aria-pressed={filtro === f}
              onClick={() => setFiltro(f)}
            >
              {t(FILTROS[f])}
            </Button>
          ))}
        </div>
        {podeRegistrar ? (
          <Button size="sm" className="ml-auto gap-1" onClick={() => setRegistrando(true)} disabled={q.isLoading}>
            <Plus className="size-4" aria-hidden />
            {t("Registrar interação")}
          </Button>
        ) : null}
      </div>

      {q.isLoading ? (
        <Card className="space-y-3 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </Card>
      ) : q.isError ? (
        <Card className="p-4 text-sm text-destructive" role="alert">
          {t("Não foi possível carregar o histórico de atendimento.")}
        </Card>
      ) : grupos.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {filtro === "todos"
            ? t("Ainda não há atendimento com este contato. Conversas e ligações pelo CRM aparecem aqui sozinhas; o que acontecer fora dele, registre pelo botão.")
            : t("Nada deste tipo nas interações carregadas.")}
        </Card>
      ) : (
        grupos.map(([chave, itens]) => (
          <section key={chave} className="space-y-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              {cabecalhoDoDia(diaDaChave(chave), t, locale)}
            </h3>
            <Card className="p-0">
              <ul className="divide-y">
                {itens.map((item) => (
                  <LinhaDoHistorico
                    key={item.id}
                    item={item}
                    negocio={item.lead_id ? negocioPorId.get(item.lead_id) : undefined}
                    t={t}
                    locale={locale}
                  />
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}

      {q.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
          </Button>
        </div>
      ) : null}

      {registrando ? (
        <RegistrarInteracaoDialog
          open={registrando}
          onOpenChange={setRegistrando}
          contactId={contactId}
          leads={leads}
        />
      ) : null}
    </div>
  );
}
