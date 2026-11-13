"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";
import { CamposObrigatoriosDialog } from "@/components/kanban/CamposObrigatoriosDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import type { RecusaDeCampos } from "@/hooks/kanban/useMoveCard";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { etapaDeDestino, type ColunaConsolidada } from "@/lib/consolidado/colunas";
import type { EmpresaDoEscopo } from "@/lib/consolidado/escopo";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { formatCents } from "@/lib/money";
import { Buildings, CaretDown } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Tipos das respostas
// ---------------------------------------------------------------------------

type Aba = "funil" | "conversas" | "contatos";

interface Negocio {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  position_in_stage: number;
  updated_at: string;
}

interface FunilDaVisao {
  id: string;
  organization_id: string;
  name: string;
  motivos_de_perda: Array<{ valor: string; rotulo: string; traduzir: boolean }>;
}

interface RespostaDoFunil {
  empresas: EmpresaDoEscopo[];
  escopo: string[];
  funis_oferecidos: Array<{ chave: string; rotulo: string; empresas: number }>;
  funil: string;
  funis: FunilDaVisao[];
  colunas: ColunaConsolidada[];
  negocios: Negocio[];
  truncados: string[];
  /** Etapas que passaram do teto: a coluna delas não mostra todos os negócios. */
  etapas_truncadas?: string[];
}

interface Conversa {
  id: string;
  organization_id: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  contacts?: { display_name?: string | null; name?: string | null; phone_number?: string | null } | null;
}

interface Contato {
  id: string;
  organization_id: string;
  display_name?: string | null;
  name?: string | null;
  phone_number?: string | null;
  email?: string | null;
  last_activity_at?: string | null;
}

interface RespostaDeLista<K extends string, T> {
  data: { empresas: EmpresaDoEscopo[]; escopo: string[] } & Record<K, T[]>;
  meta?: { has_more?: boolean };
}

// ---------------------------------------------------------------------------
// Cor por empresa
// ---------------------------------------------------------------------------

/**
 * Cor estável de cada empresa, pela posição dela na lista da pessoa. Matiz
 * espaçado pela razão áurea, para empresas vizinhas não ficarem parecidas; a
 * saturação/luz média lê nos dois temas, e o nome vai SEMPRE escrito ao lado —
 * a cor ajuda a bater o olho, nunca é a única pista.
 */
function corDaEmpresa(indice: number): string {
  const matiz = Math.round((indice * 137.508) % 360);
  return `hsl(${matiz} 65% 48%)`;
}

function SeloDaEmpresa({ nome, cor }: { nome: string; cor: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium">
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: cor }} />
      <span className="truncate">{nome}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Seletor de empresas
// ---------------------------------------------------------------------------

function SeletorDeEmpresas({
  empresas,
  selecionadas: pedidas,
  onMudar,
  cores,
}: {
  empresas: EmpresaDoEscopo[];
  /** Vazio = todas. */
  selecionadas: string[];
  onMudar: (ids: string[]) => void;
  cores: Map<string, string>;
}) {
  const t = useT();
  // A URL pode trazer id que não é da pessoa (link de um colega, empresa de que
  // ela saiu). O servidor ignora esses ids; o rótulo também, senão a tela diria
  // "2 empresas" mostrando os dados de todas.
  const selecionadas = pedidas.filter((id) => empresas.some((e) => e.organization_id === id));
  const todas = selecionadas.length === 0 || selecionadas.length === empresas.length;
  const marcada = (id: string) => todas || selecionadas.includes(id);
  const rotulo = todas
    ? t("Todas as empresas ({n})").replace("{n}", String(empresas.length))
    : selecionadas.length === 1
      ? (empresas.find((e) => e.organization_id === selecionadas[0])?.nome ?? t("1 empresa"))
      : t("{n} empresas").replace("{n}", String(selecionadas.length));

  const alternar = (id: string) => {
    const atuais = todas ? empresas.map((e) => e.organization_id) : selecionadas;
    const prox = atuais.includes(id) ? atuais.filter((x) => x !== id) : [...atuais, id];
    // Desmarcar a última não deixa a tela vazia: volta para todas.
    onMudar(prox.length === 0 || prox.length === empresas.length ? [] : prox);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" data-testid="seletor-de-empresas">
          <Buildings size={16} aria-hidden />
          <span className="max-w-[220px] truncate">{rotulo}</span>
          <CaretDown size={12} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-2">
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-xs text-muted-foreground">{t("Empresas na visão")}</span>
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => onMudar([])}
          >
            {t("Todas")}
          </button>
        </div>
        <div className="max-h-[320px] space-y-0.5 overflow-auto">
          {empresas.map((e) => (
            <label
              key={e.organization_id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-accent)]"
                checked={marcada(e.organization_id)}
                onChange={() => alternar(e.organization_id)}
              />
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: cores.get(e.organization_id) }}
              />
              <span className="truncate">{e.nome}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Funil
// ---------------------------------------------------------------------------

/** O que um movimento pode levar junto, na mesma escrita da etapa. */
interface ExtrasDoMovimento {
  lostReason?: string;
  wonReason?: string;
  customFields?: Record<string, unknown>;
}

interface MovimentoPendente {
  negocio: Negocio;
  stageId: string;
  coluna: ColunaConsolidada;
}

function FunilConsolidado({
  dados,
  cores,
  nomes,
  onAbrir,
  onTrocarFunil,
}: {
  dados: RespostaDoFunil;
  cores: Map<string, string>;
  nomes: Map<string, string>;
  onAbrir: (orgId: string, destino: string) => void;
  onTrocarFunil: (funil: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [sobre, setSobre] = useState<string | null>(null);
  const [movendo, setMovendo] = useState<Set<string>>(new Set());
  const [aPerder, setAPerder] = useState<MovimentoPendente | null>(null);
  const [motivo, setMotivo] = useState("");
  /** Onde cada card está AGORA na tela (movimento otimista), por id. */
  const [local, setLocal] = useState<Map<string, string>>(new Map());
  /** O movimento que o servidor recusou por campos faltando, esperando o diálogo. */
  const [camposPendentes, setCamposPendentes] = useState<{
    negocio: Negocio;
    stageId: string;
    recusa: RecusaDeCampos;
  } | null>(null);

  const funilPorId = useMemo(() => new Map(dados.funis.map((f) => [f.id, f])), [dados.funis]);
  const etapaParaColuna = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of dados.colunas) for (const e of c.etapas) m.set(e.stage_id, c.chave);
    return m;
  }, [dados.colunas]);

  const cardsPorColuna = useMemo(() => {
    const m = new Map<string, Negocio[]>();
    for (const n of dados.negocios) {
      const stage = local.get(n.id) ?? n.stage_id;
      const chave = etapaParaColuna.get(stage);
      if (!chave) continue;
      const lista = m.get(chave) ?? [];
      lista.push(n);
      m.set(chave, lista);
    }
    return m;
  }, [dados.negocios, etapaParaColuna, local]);

  /**
   * Devolve o card ao que o SERVIDOR diz. A posição local só vale enquanto o
   * movimento está em curso: guardada depois do sucesso, ela prendia o card na
   * coluna do arrasto mesmo quando outra pessoa (ou a IA) o movia em seguida —
   * a lista recarregava e a tela seguia mostrando a etapa velha.
   */
  function soltarPosicaoLocal(id: string) {
    setLocal((p) => {
      if (!p.has(id)) return p;
      const prox = new Map(p);
      prox.delete(id);
      return prox;
    });
  }

  async function enviar(negocio: Negocio, stageId: string, extras: ExtrasDoMovimento = {}) {
    setLocal((p) => new Map(p).set(negocio.id, stageId));
    setMovendo((p) => new Set(p).add(negocio.id));
    try {
      await apiClient.post("/api/v1/consolidado/funil/mover", {
        lead_id: negocio.id,
        stage_id: stageId,
        ...(extras.lostReason ? { lost_reason: extras.lostReason } : {}),
        ...(extras.wonReason ? { won_reason: extras.wonReason } : {}),
        ...(extras.customFields ? { custom_fields: extras.customFields } : {}),
      });
      // Espera a lista recarregar ANTES de soltar: sem isso o card piscaria de
      // volta na coluna antiga entre o sucesso e a resposta nova.
      await queryClient.invalidateQueries({ queryKey: ["consolidado", "funil"] });
    } catch (err) {
      // O destino exige campos (ou o motivo do ganho): em vez de "deu errado",
      // o mesmo diálogo do quadro pede só o que falta e reenvia o MESMO
      // movimento, com os valores na mesma escrita (#1536).
      const faltando = (err instanceof ApiError ? err.details?.faltando : undefined) as
        | RecusaDeCampos["faltando"]
        | undefined;
      if (err instanceof ApiError && err.status === 422 && Array.isArray(faltando) && faltando.length > 0) {
        pedirCampos(negocio, stageId, faltando);
      } else {
        toast.error(err instanceof Error ? err.message : t("Não foi possível mover o negócio."));
      }
    } finally {
      soltarPosicaoLocal(negocio.id);
      setMovendo((p) => {
        const prox = new Set(p);
        prox.delete(negocio.id);
        return prox;
      });
    }
  }

  function moverPara(negocio: Negocio, coluna: ColunaConsolidada) {
    const atual = local.get(negocio.id) ?? negocio.stage_id;
    if (etapaParaColuna.get(atual) === coluna.chave) return;
    const stageId = etapaDeDestino(coluna, negocio.pipeline_id);
    if (!stageId) {
      toast.error(
        t("O funil de {empresa} não tem a etapa \"{etapa}\".")
          .replace("{empresa}", nomes.get(negocio.organization_id) ?? "")
          .replace("{etapa}", coluna.rotulo),
      );
      return;
    }
    if (coluna.tipo === "perdido") {
      setMotivo("");
      setAPerder({ negocio, stageId, coluna });
      return;
    }
    void enviar(negocio, stageId);
  }

  /**
   * Abre o diálogo de campos obrigatórios. Campo de ARQUIVO é a exceção: o
   * anexo sobe pela rota da empresa ativa, e o card pode ser de outra — então
   * a tela oferece abrir o negócio na empresa dele, onde o anexo funciona.
   */
  function pedirCampos(negocio: Negocio, stageId: string, faltando: RecusaDeCampos["faltando"]) {
    if (faltando.some((c) => c.tipo === "file")) {
      toast.warning(t("Esta etapa pede um arquivo anexado. Abra o negócio para anexar e mover."), {
        action: {
          label: t("Abrir o negócio"),
          onClick: () => onAbrir(negocio.organization_id, `/app/leads/${negocio.id}`),
        },
      });
      return;
    }
    setCamposPendentes({
      negocio,
      stageId,
      recusa: {
        // O diálogo só lê `faltando` e, para anexo, `args.leadId`; o resto do
        // `MoveArgs` é do quadro de uma empresa e não viaja daqui.
        args: { leadId: negocio.id, stageId, positionInStage: 0, expectedUpdatedAt: "" },
        faltando,
      },
    });
  }

  const funilDoPendente = aPerder ? funilPorId.get(aPerder.negocio.pipeline_id) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("Funil")}</span>
        <Select value={dados.funil} onValueChange={onTrocarFunil}>
          <SelectTrigger className="w-[260px]" aria-label={t("Funil")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="padrao">{t("Funil padrão de cada empresa")}</SelectItem>
            {dados.funis_oferecidos.map((f) => (
              <SelectItem key={f.chave} value={f.chave}>
                {f.rotulo} ({t("{n} empresa(s)").replace("{n}", String(f.empresas))})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {dados.truncados.length > 0 && (
          <span className="text-xs text-warning-fg" role="status">
            {t("Algumas etapas têm muitos negócios: mostrando os 100 primeiros de cada uma.")}
          </span>
        )}
      </div>

      {dados.colunas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum funil encontrado nas empresas selecionadas.")}</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2" data-testid="funil-consolidado">
          {dados.colunas.map((coluna) => {
            const cards = cardsPorColuna.get(coluna.chave) ?? [];
            const cortada = coluna.etapas.some((e) => dados.etapas_truncadas?.includes(e.stage_id));
            const totalPorMoeda = new Map<string, number>();
            for (const c of cards) {
              if (c.value_cents == null) continue;
              const moeda = c.currency ?? "BRL";
              totalPorMoeda.set(moeda, (totalPorMoeda.get(moeda) ?? 0) + c.value_cents);
            }
            return (
              <section
                key={coluna.chave}
                aria-label={coluna.rotulo}
                data-coluna={coluna.chave}
                onDragOver={(e) => {
                  if (!arrastando) return;
                  e.preventDefault();
                  setSobre(coluna.chave);
                }}
                onDragLeave={() => setSobre((s) => (s === coluna.chave ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  setSobre(null);
                  const negocio = dados.negocios.find((n) => n.id === arrastando);
                  setArrastando(null);
                  if (negocio) moverPara(negocio, coluna);
                }}
                className={cn(
                  "flex w-[280px] shrink-0 flex-col rounded-lg border bg-muted/30",
                  sobre === coluna.chave && "ring-2 ring-accent",
                )}
              >
                <header className="space-y-0.5 border-b px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate text-sm font-semibold">{coluna.rotulo}</h2>
                    <Badge variant={coluna.tipo === "ganho" ? "success" : coluna.tipo === "perdido" ? "error" : "neutral"}>
                      {cortada ? `${cards.length}+` : cards.length}
                    </Badge>
                  </div>
                  {totalPorMoeda.size > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {[...totalPorMoeda].map(([moeda, v]) => formatCents(v, moeda)).join(" · ")}
                    </p>
                  )}
                  {cortada && (
                    <p className="text-[11px] text-warning-fg" data-testid="coluna-cortada">
                      {t("Há mais negócios nesta etapa do que os mostrados.")}
                    </p>
                  )}
                  {coluna.etapas.length < dados.funis.length && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("Existe em {n} de {total} funis").replace("{n}", String(coluna.etapas.length)).replace("{total}", String(dados.funis.length))}
                    </p>
                  )}
                </header>
                <div className="flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {cards.map((n) => {
                    const destinos = dados.colunas.filter(
                      (c) => c.chave !== coluna.chave && etapaDeDestino(c, n.pipeline_id),
                    );
                    return (
                      <article
                        key={n.id}
                        draggable={!movendo.has(n.id)}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", n.id);
                          setArrastando(n.id);
                        }}
                        onDragEnd={() => {
                          setArrastando(null);
                          setSobre(null);
                        }}
                        data-testid="card-consolidado"
                        data-empresa={n.organization_id}
                        className={cn(
                          "space-y-2 rounded-md border bg-card p-2.5 shadow-sm",
                          movendo.has(n.id) && "opacity-60",
                          arrastando === n.id && "opacity-40",
                        )}
                      >
                        <SeloDaEmpresa
                          nome={nomes.get(n.organization_id) ?? "—"}
                          cor={cores.get(n.organization_id) ?? "gray"}
                        />
                        <button
                          type="button"
                          className="block w-full text-left text-sm font-medium hover:underline"
                          onClick={() => onAbrir(n.organization_id, `/app/leads/${n.id}`)}
                        >
                          {n.title}
                        </button>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">
                            {n.value_cents != null ? formatCents(n.value_cents, n.currency ?? "BRL") : ""}
                          </span>
                          {/* Mover sem arrastar: celular (sem drag) e teclado. */}
                          {destinos.length > 0 && (
                            <Select
                              value=""
                              onValueChange={(chave) => {
                                const destino = dados.colunas.find((c) => c.chave === chave);
                                if (destino) moverPara(n, destino);
                              }}
                              disabled={movendo.has(n.id)}
                            >
                              <SelectTrigger
                                className="h-7 w-[110px] text-xs"
                                aria-label={t("Mover {negocio} para").replace("{negocio}", n.title)}
                              >
                                <SelectValue placeholder={t("Mover…")} />
                              </SelectTrigger>
                              <SelectContent>
                                {destinos.map((c) => (
                                  <SelectItem key={c.chave} value={c.chave}>
                                    {c.rotulo}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={!!aPerder} onOpenChange={(aberto) => !aberto && setAPerder(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Por que este negócio foi perdido?")}</DialogTitle>
          </DialogHeader>
          {aPerder && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {aPerder.negocio.title} · {nomes.get(aPerder.negocio.organization_id)}
              </p>
              <Select value={motivo} onValueChange={setMotivo}>
                <SelectTrigger aria-label={t("Motivo da perda")}>
                  <SelectValue placeholder={t("Escolha o motivo")} />
                </SelectTrigger>
                <SelectContent>
                  {(funilDoPendente?.motivos_de_perda ?? []).map((m) => (
                    <SelectItem key={m.valor} value={m.valor}>
                      {m.traduzir ? t(m.rotulo) : m.rotulo}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAPerder(null)}>
              {t("Cancelar")}
            </Button>
            <Button
              disabled={!motivo}
              onClick={() => {
                if (!aPerder) return;
                const { negocio, stageId } = aPerder;
                setAPerder(null);
                void enviar(negocio, stageId, { lostReason: motivo });
              }}
            >
              {t("Marcar como perdido")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CamposObrigatoriosDialog
        open={camposPendentes !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setCamposPendentes(null);
        }}
        recusa={camposPendentes?.recusa ?? null}
        moeda={camposPendentes?.negocio.currency ?? undefined}
        isPending={camposPendentes ? movendo.has(camposPendentes.negocio.id) : false}
        onConfirmar={({ customFields, wonReason }) => {
          if (!camposPendentes) return;
          const { negocio, stageId } = camposPendentes;
          setCamposPendentes(null);
          void enviar(negocio, stageId, {
            ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
            ...(wonReason ? { wonReason } : {}),
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversas e Contatos
// ---------------------------------------------------------------------------

function ListaConsolidada<T extends { id: string; organization_id: string }>({
  itens,
  truncado,
  cores,
  nomes,
  vazio,
  linha,
  onAbrir,
}: {
  itens: T[];
  truncado: boolean;
  cores: Map<string, string>;
  nomes: Map<string, string>;
  vazio: string;
  linha: (item: T) => { titulo: string; detalhe: string; destino: string; quando?: string | null };
  onAbrir: (orgId: string, destino: string) => void;
}) {
  const t = useT();
  if (itens.length === 0) return <p className="text-sm text-muted-foreground">{vazio}</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border">
        {itens.map((item) => {
          const l = linha(item);
          return (
            <li key={`${item.organization_id}:${item.id}`}>
              <button
                type="button"
                onClick={() => onAbrir(item.organization_id, l.destino)}
                className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-muted sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="sm:w-[180px] sm:shrink-0">
                  <SeloDaEmpresa
                    nome={nomes.get(item.organization_id) ?? "—"}
                    cor={cores.get(item.organization_id) ?? "gray"}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{l.titulo}</span>
                  <span className="block truncate text-xs text-muted-foreground">{l.detalhe}</span>
                </span>
                {l.quando && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(l.quando).toLocaleString()}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {truncado && (
        <p className="text-xs text-muted-foreground" role="status">
          {t("Mostrando os mais recentes. Use a busca para achar outros.")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export function ConsolidadoClient({
  empresaAtiva,
  emSuporte,
}: {
  empresaAtiva: string | null;
  emSuporte: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const aba: Aba = (["funil", "conversas", "contatos"] as const).find((a) => a === searchParams.get("aba")) ?? "funil";
  const empresasParam = searchParams.get("empresas") ?? "";
  const selecionadas = useMemo(() => empresasParam.split(",").filter(Boolean), [empresasParam]);
  const funilParam = searchParams.get("funil") ?? "padrao";
  const [busca, setBusca] = useState("");
  const [buscaAplicada, setBuscaAplicada] = useState("");
  const [abrindo, setAbrindo] = useState(false);

  /** O filtro mora na URL: link compartilhável e F5 sem perder a escolha. */
  function mudarUrl(mudancas: Record<string, string | null>) {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(mudancas)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const qsEmpresas = empresasParam ? `empresas=${encodeURIComponent(empresasParam)}` : "";

  const funil = useQuery({
    queryKey: ["consolidado", "funil", empresasParam, funilParam],
    enabled: aba === "funil" && !emSuporte,
    queryFn: () =>
      apiClient.get<{ data: RespostaDoFunil }>(
        `/api/v1/consolidado/funil?${[qsEmpresas, `funil=${encodeURIComponent(funilParam)}`].filter(Boolean).join("&")}`,
      ),
  });
  const conversas = useQuery({
    queryKey: ["consolidado", "conversas", empresasParam, buscaAplicada],
    enabled: aba === "conversas" && !emSuporte,
    queryFn: () =>
      apiClient.get<RespostaDeLista<"conversas", Conversa>>(
        `/api/v1/consolidado/conversas?${[qsEmpresas, buscaAplicada && `search=${encodeURIComponent(buscaAplicada)}`].filter(Boolean).join("&")}`,
      ),
  });
  const contatos = useQuery({
    queryKey: ["consolidado", "contatos", empresasParam, buscaAplicada],
    enabled: aba === "contatos" && !emSuporte,
    queryFn: () =>
      apiClient.get<RespostaDeLista<"contatos", Contato>>(
        `/api/v1/consolidado/contatos?${[qsEmpresas, buscaAplicada && `search=${encodeURIComponent(buscaAplicada)}`].filter(Boolean).join("&")}`,
      ),
  });

  const atual = aba === "funil" ? funil : aba === "conversas" ? conversas : contatos;
  const empresasDaAba =
    aba === "funil"
      ? funil.data?.data.empresas
      : aba === "conversas"
        ? conversas.data?.data.empresas
        : contatos.data?.data.empresas;
  const empresas: EmpresaDoEscopo[] = useMemo(() => empresasDaAba ?? [], [empresasDaAba]);
  const cores = useMemo(
    () => new Map(empresas.map((e, i) => [e.organization_id, corDaEmpresa(i)])),
    [empresas],
  );
  const nomes = useMemo(() => new Map(empresas.map((e) => [e.organization_id, e.nome])), [empresas]);

  /**
   * Abrir um item de OUTRA empresa troca a empresa ativa antes: a tela de
   * destino (negócio, conversa, contato) opera uma empresa por vez. Documento
   * novo, como no seletor de empresa do cabeçalho — elimina cache e assinaturas
   * da empresa anterior.
   */
  async function abrir(orgId: string, destino: string) {
    if (orgId === empresaAtiva) {
      router.push(destino);
      return;
    }
    setAbrindo(true);
    const r = await setActiveOrg(orgId).catch(() => ({ ok: false as const }));
    if (!r.ok) {
      setAbrindo(false);
      toast.error(t("Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente."));
      return;
    }
    window.location.assign(destino);
  }

  if (emSuporte) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("Encerre o acompanhamento antes de abrir a visão consolidada.")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6" aria-busy={abrindo}>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Visão consolidada")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Funil, conversas e contatos das suas empresas numa tela só.")}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t("Visão consolidada")} className="inline-flex rounded-md border p-0.5">
          {(
            [
              ["funil", t("Funil")],
              ["conversas", t("Conversas")],
              ["contatos", t("Contatos")],
            ] as const
          ).map(([valor, rotulo]) => (
            <button
              key={valor}
              type="button"
              role="tab"
              aria-selected={aba === valor}
              onClick={() => mudarUrl({ aba: valor === "funil" ? null : valor })}
              className={cn(
                "rounded-md px-3 py-1 text-sm",
                aba === valor ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {rotulo}
            </button>
          ))}
        </div>
        {empresas.length > 0 && (
          <SeletorDeEmpresas
            empresas={empresas}
            selecionadas={selecionadas}
            cores={cores}
            onMudar={(ids) => mudarUrl({ empresas: ids.join(",") || null })}
          />
        )}
        {aba !== "funil" && (
          <form
            className="flex min-w-[200px] flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setBuscaAplicada(busca.trim());
            }}
          >
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar por nome ou telefone")}
              aria-label={t("Buscar por nome ou telefone")}
            />
            <Button type="submit" variant="outline">
              {t("Buscar")}
            </Button>
          </form>
        )}
      </div>

      {atual.isLoading ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : atual.isError ? (
        <p className="text-sm text-destructive">
          {atual.error instanceof Error ? atual.error.message : t("Não foi possível carregar.")}
        </p>
      ) : empresas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Você ainda não participa de nenhuma empresa ativa.")}</p>
      ) : (
        <>
          {empresas.length === 1 && (
            <p className="text-xs text-muted-foreground">
              {t("Você participa de uma empresa só. Quando tiver acesso a outras, elas aparecem aqui juntas.")}
            </p>
          )}
          {aba === "funil" && funil.data && (
            <FunilConsolidado
              dados={funil.data.data}
              cores={cores}
              nomes={nomes}
              onAbrir={abrir}
              onTrocarFunil={(f) => mudarUrl({ funil: f === "padrao" ? null : f })}
            />
          )}
          {aba === "conversas" && conversas.data && (
            <ListaConsolidada
              itens={conversas.data.data.conversas}
              truncado={!!conversas.data.meta?.has_more}
              cores={cores}
              nomes={nomes}
              vazio={t("Nenhuma conversa encontrada.")}
              onAbrir={abrir}
              linha={(c) => ({
                titulo: rotuloDoContato(c.contacts, t),
                detalhe: c.last_message_preview ?? "",
                destino: `/app/inbox/${c.id}`,
                quando: c.last_message_at,
              })}
            />
          )}
          {aba === "contatos" && contatos.data && (
            <ListaConsolidada
              itens={contatos.data.data.contatos}
              truncado={!!contatos.data.meta?.has_more}
              cores={cores}
              nomes={nomes}
              vazio={t("Nenhum contato encontrado.")}
              onAbrir={abrir}
              linha={(c) => ({
                titulo: rotuloDoContato(c, t),
                detalhe: [c.phone_number, c.email].filter(Boolean).join(" · "),
                destino: `/app/contacts/${c.id}`,
                quando: c.last_activity_at,
              })}
            />
          )}
        </>
      )}
    </div>
  );
}
