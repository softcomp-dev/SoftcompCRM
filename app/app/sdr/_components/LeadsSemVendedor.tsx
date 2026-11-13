"use client";
/**
 * A fila do SDR (docs/features/sdr.md): os negócios abertos que estão com ele
 * ou sem dono humano, e em cada linha a escolha do vendedor e o "Passar".
 *
 * Nada é decidido aqui. Quem pode ver, o que entra e para quem se passa vêm do
 * servidor: `GET /api/v1/sdr/vendedores` (se este membro pode passar, e para
 * quem), `GET /api/v1/sdr/negocios` (a lista, pela régua de `recusaDoNegocio`)
 * e `POST /api/v1/leads/[id]/passar-ao-vendedor` (a passagem, a mesma do menu
 * do card do funil).
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  useNegociosDoSdr,
  usePassarAoVendedor,
  useVendedoresDoSdr,
  type NegocioDoSdr,
} from "@/hooks/sdr/useSdr";
import { formatCents } from "@/lib/money";
import { ArrowBendUpRight, CheckCircle, Signpost } from "@/lib/ui/icons";

type Filtro = "todos" | NegocioDoSdr["situacao"];

const FILTROS: ReadonlyArray<{ id: Filtro; rotulo: string }> = [
  { id: "todos", rotulo: "Todos" },
  { id: "comigo", rotulo: "Comigo" },
  { id: "fila", rotulo: "Na fila" },
  { id: "ia", rotulo: "Com a IA" },
];

/** Há quanto tempo o negócio chegou, curto: "3h", "2d". Pura, para teste. */
export function haQuantoTempo(iso: string, agora: Date = new Date()): string {
  const horas = Math.max(0, Math.floor((agora.getTime() - new Date(iso).getTime()) / 3_600_000));
  if (horas < 1) return "<1h";
  if (horas < 48) return `${horas}h`;
  return `${Math.floor(horas / 24)}d`;
}

/** A frase de quem não pode usar a tela, pelo motivo que o servidor deu. */
export function fraseDeQuemNaoPode(motivo: string | null): string {
  if (motivo === "feature_disabled") return "A função SDR está desligada nesta empresa.";
  return "Esta tela é de quem faz a pré-venda. Peça ao administrador para marcar você como SDR em Equipe › Membros.";
}

export function LeadsSemVendedor() {
  const t = useT();
  const permissao = useVendedoresDoSdr(true);
  const { data: doSdr, isLoading: carregandoPermissao } = permissao;
  const podePassar = doSdr?.pode_passar === true;
  const equipe = useAssignableMembers(podePassar);
  const { data: membros } = equipe;
  const lista = useNegociosDoSdr(podePassar);
  const { data: resposta, isLoading: carregandoLista } = lista;
  // Falha de leitura NÃO é "você não é SDR" nem "não há vendedor": sem isto, um
  // 500 na permissão mandava o SDR pedir ao administrador o que ele já tem.
  const isError = permissao.isError || lista.isError || equipe.isError;
  const [filtro, setFiltro] = useState<Filtro>("todos");

  const vendedores = useMemo(
    () => (membros ?? []).filter((m) => doSdr?.vendedores.includes(m.user_id)),
    [membros, doSdr],
  );
  const negocios = useMemo(() => resposta?.data ?? [], [resposta]);
  const contagem = useMemo(() => {
    const c: Record<Filtro, number> = { todos: negocios.length, comigo: 0, fila: 0, ia: 0 };
    for (const n of negocios) c[n.situacao] += 1;
    return c;
  }, [negocios]);
  const visiveis = filtro === "todos" ? negocios : negocios.filter((n) => n.situacao === filtro);

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="sdr-erro" role="alert">
        <p className="text-sm text-destructive">{t("Não foi possível carregar os leads sem vendedor.")}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void permissao.refetch();
            if (podePassar) {
              void equipe.refetch();
              void lista.refetch();
            }
          }}
        >
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  if (carregandoPermissao || (podePassar && (carregandoLista || equipe.isLoading))) {
    return (
      <div className="space-y-2" data-testid="sdr-carregando">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!podePassar) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"
        data-testid="sdr-sem-acesso"
      >
        <Signpost size={28} className="text-muted-foreground" aria-hidden />
        <p className="max-w-md text-sm text-muted-foreground">{t(fraseDeQuemNaoPode(doSdr?.motivo ?? null))}</p>
      </div>
    );
  }

  if (negocios.length === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"
        data-testid="sdr-vazio"
      >
        <CheckCircle size={28} className="text-success-fg/70" aria-hidden />
        <p className="text-sm font-medium">{t("Nenhum lead esperando vendedor")}</p>
        <p className="text-xs text-muted-foreground">
          {t("Os negócios que chegarem para você ou ficarem sem dono aparecem aqui.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Filtrar por situação")}>
        {FILTROS.map((f) => (
          <Button
            key={f.id}
            type="button"
            aria-pressed={filtro === f.id}
            size="sm"
            variant={filtro === f.id ? "default" : "outline"}
            onClick={() => setFiltro(f.id)}
            data-testid={`sdr-filtro-${f.id}`}
          >
            {t(f.rotulo)} <span className="ml-1 tabular-nums opacity-70">{contagem[f.id]}</span>
          </Button>
        ))}
      </div>

      {resposta?.meta?.has_more ? (
        <p className="text-xs text-muted-foreground" data-testid="sdr-truncado">
          {t("Mostrando os 200 mais antigos. Passe estes para ver os seguintes.")}
        </p>
      ) : null}

      {vendedores.length === 0 ? (
        <p className="rounded-md border border-warning-border bg-warning-bg/40 p-3 text-sm" data-testid="sdr-sem-vendedores">
          {t("Nenhum vendedor disponível na equipe.")}
        </p>
      ) : null}

      <ul className="flex flex-col divide-y rounded-lg border" data-testid="sdr-lista">
        {visiveis.map((n) => (
          <LinhaDoNegocio key={n.id} negocio={n} vendedores={vendedores} />
        ))}
        {visiveis.length === 0 ? (
          <li className="p-4 text-sm text-muted-foreground">{t("Nenhum negócio nesta situação.")}</li>
        ) : null}
      </ul>
    </div>
  );
}

function LinhaDoNegocio({
  negocio,
  vendedores,
}: {
  negocio: NegocioDoSdr;
  vendedores: ReadonlyArray<{ user_id: string; full_name: string | null }>;
}) {
  const t = useT();
  const passar = usePassarAoVendedor();
  const [escolhido, setEscolhido] = useState<string>("");
  const nomeDoEscolhido = vendedores.find((v) => v.user_id === escolhido)?.full_name ?? t("o vendedor");

  const situacao =
    negocio.situacao === "comigo"
      ? t("Com você")
      : negocio.situacao === "ia"
        ? `${t("Com a IA")}${negocio.owner_agent_name ? ` · ${negocio.owner_agent_name}` : ""}`
        : t("Na fila");

  return (
    <li className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between" data-testid="sdr-negocio">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link href={`/app/leads/${negocio.id}`} className="truncate font-medium hover:underline">
            {negocio.title}
          </Link>
          <Badge variant={negocio.situacao === "comigo" ? "info" : "secondary"}>{situacao}</Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {[
            negocio.contact_name,
            [negocio.pipeline_name, negocio.stage_name].filter(Boolean).join(" › "),
            negocio.value_cents !== null ? formatCents(negocio.value_cents, negocio.currency ?? "BRL") : null,
            `${t("chegou há")} ${haQuantoTempo(negocio.created_at)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Select value={escolhido} onValueChange={setEscolhido} disabled={vendedores.length === 0 || passar.isPending || passar.isSuccess}>
          <SelectTrigger className="min-w-0 flex-1 md:w-[200px] md:flex-none" aria-label={t("Escolha o vendedor")} data-testid="sdr-escolher-vendedor">
            <SelectValue placeholder={t("Escolha o vendedor")} />
          </SelectTrigger>
          <SelectContent>
            {vendedores.map((v) => (
              <SelectItem key={v.user_id} value={v.user_id}>
                {v.full_name ?? t("Sem nome")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          // `isSuccess`: a linha ainda fica na tela até a lista recarregar, e um
          // segundo clique viraria "este negócio está com outra pessoa".
          disabled={!escolhido || passar.isPending || passar.isSuccess}
          onClick={() => passar.mutate({ leadId: negocio.id, userId: escolhido, nome: nomeDoEscolhido })}
          data-testid="sdr-passar"
        >
          <ArrowBendUpRight size={14} className="mr-1" aria-hidden />
          {t("Passar")}
        </Button>
      </div>
    </li>
  );
}
