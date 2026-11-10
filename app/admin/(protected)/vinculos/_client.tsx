"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  diferencaDosVinculos,
  totalDeMudancas,
  type MarcaDaEmpresa,
  type VinculoGravado,
} from "@/lib/admin/vinculos-diff";
import type { Role } from "@/lib/auth/types";
import { LinkIcon, MagnifyingGlass } from "@/lib/ui/icons";

// ---------------------------------------------------------------------------
// Tipos das respostas
// ---------------------------------------------------------------------------

interface Conta {
  id: string;
  email: string | null;
  full_name: string | null;
}

interface Empresa {
  id: string;
  display_name: string;
  slug: string;
  status: string;
}

interface VinculosDaConta {
  empresas: Empresa[];
  vinculos: Array<VinculoGravado & { accepted_at: string | null }>;
}

interface ResultadoDoVincular {
  vinculadas: string[];
  ja_ativas: string[];
  falhas: Array<{ organization_id: string; motivo: string }>;
}

const PAPEIS: Array<{ valor: Role; rotulo: string }> = [
  { valor: "viewer", rotulo: "Leitor" },
  { valor: "agent", rotulo: "Agente" },
  { valor: "manager", rotulo: "Gerente" },
  { valor: "admin", rotulo: "Admin" },
];

function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Busca de conta
// ---------------------------------------------------------------------------

function BuscaDeConta({ onEscolher }: { onEscolher: (c: Conta) => void }) {
  const t = useT();
  const [texto, setTexto] = useState("");
  const [termo, setTermo] = useState("");
  const espera = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isFetching, isError } = useQuery({
    queryKey: ["admin", "vinculos", "contas", termo],
    enabled: termo.length >= 2,
    queryFn: () =>
      apiClient.get<{ data: Conta[] }>(
        `/api/v1/admin/vinculos/contas?q=${encodeURIComponent(termo)}`,
      ),
    staleTime: 30_000,
  });
  const contas = data?.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("1. Escolha a conta")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <MagnifyingGlass
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t("Buscar conta por e-mail ou nome")}
            placeholder={t("Buscar conta por e-mail ou nome")}
            className="pl-9"
            value={texto}
            onChange={(e) => {
              const v = e.target.value;
              setTexto(v);
              if (espera.current) clearTimeout(espera.current);
              espera.current = setTimeout(() => setTermo(v.trim()), 300);
            }}
          />
        </div>
        {termo.length >= 2 && (
          <div className="divide-y rounded-md border">
            {isFetching && contas.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t("Buscando…")}</p>
            ) : isError ? (
              <p className="px-3 py-2 text-xs text-destructive">{t("Não foi possível buscar as contas.")}</p>
            ) : contas.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t("Nenhuma conta encontrada. A pessoa precisa ter criado a conta (ou recebido um convite) antes.")}
              </p>
            ) : (
              contas.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onEscolher(c)}
                  className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted"
                >
                  <span className="text-sm font-medium">{c.full_name ?? c.email ?? c.id}</span>
                  {c.full_name && c.email && (
                    <span className="font-mono text-xs text-muted-foreground">{c.email}</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Lista de empresas da conta
// ---------------------------------------------------------------------------

function EmpresasDaConta({ conta }: { conta: Conta }) {
  const t = useT();
  const queryClient = useQueryClient();
  const chave = useMemo(() => ["admin", "vinculos", "conta", conta.id] as const, [conta.id]);
  const { data, isLoading, isError } = useQuery({
    queryKey: chave,
    queryFn: () =>
      apiClient.get<{ data: VinculosDaConta }>(`/api/v1/admin/users/${conta.id}/vinculos`),
  });
  const empresas = useMemo(() => data?.data.empresas ?? [], [data]);
  const gravados = useMemo(() => data?.data.vinculos ?? [], [data]);

  const [papelPadrao, setPapelPadrao] = useState<Role>("agent");
  const [filtro, setFiltro] = useState("");
  const [tela, setTela] = useState<Map<string, MarcaDaEmpresa>>(new Map());
  const [salvando, setSalvando] = useState(false);
  const [falhas, setFalhas] = useState<Array<{ organization_id: string; motivo: string }>>([]);

  // A tela nasce do que está gravado — e volta a ele a cada recarga.
  // O papel de quem nunca esteve na empresa é o do SELETOR no momento em que
  // ela for marcada (ver `marcar`), por isso aqui basta um valor qualquer.
  const marcasDoGravado = useCallback((): Map<string, MarcaDaEmpresa> => {
    const ativos = new Map(gravados.filter((v) => !v.revoked_at).map((v) => [v.organization_id, v.role]));
    const anteriores = new Map(gravados.map((v) => [v.organization_id, v.role]));
    return new Map(
      empresas.map((e) => [
        e.id,
        {
          marcada: ativos.has(e.id),
          papel: ativos.get(e.id) ?? anteriores.get(e.id) ?? ("agent" as Role),
        },
      ]),
    );
  }, [empresas, gravados]);

  // Ajuste no RENDER quando chega dado novo do servidor (e não em efeito, que
  // pintaria uma vez com a tela velha).
  const [dadoDaTela, setDadoDaTela] = useState<typeof data>(undefined);
  if (data !== dadoDaTela) {
    setDadoDaTela(data);
    setTela(marcasDoGravado());
  }

  const diferenca = useMemo(() => diferencaDosVinculos(gravados, tela), [gravados, tela]);
  const mudancas = totalDeMudancas(diferenca);
  const statusGravado = useMemo(
    () => new Map(gravados.map((v) => [v.organization_id, v.revoked_at ? "revogado" : "ativo"])),
    [gravados],
  );

  const visiveis = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    if (!f) return empresas;
    return empresas.filter(
      (e) => e.display_name.toLowerCase().includes(f) || e.slug.toLowerCase().includes(f),
    );
  }, [empresas, filtro]);

  const marcar = (orgId: string, marcada: boolean) =>
    setTela((prev) => {
      const prox = new Map(prev);
      const atual = prox.get(orgId) ?? { marcada: false, papel: papelPadrao };
      prox.set(orgId, { ...atual, marcada, papel: marcada && !atual.marcada && !statusGravado.has(orgId) ? papelPadrao : atual.papel });
      return prox;
    });

  const trocarPapel = (orgId: string, papel: Role) =>
    setTela((prev) => {
      const prox = new Map(prev);
      const atual = prox.get(orgId) ?? { marcada: true, papel };
      prox.set(orgId, { ...atual, papel });
      return prox;
    });

  /** "Marcar todas" vale para as VISÍVEIS: com filtro, marca só o que se vê. */
  const marcarVisiveis = (marcada: boolean) =>
    setTela((prev) => {
      const prox = new Map(prev);
      for (const e of visiveis) {
        const atual = prox.get(e.id) ?? { marcada: false, papel: papelPadrao };
        prox.set(e.id, {
          marcada,
          papel: marcada && !atual.marcada && !statusGravado.has(e.id) ? papelPadrao : atual.papel,
        });
      }
      return prox;
    });

  async function salvar() {
    setSalvando(true);
    const novasFalhas: Array<{ organization_id: string; motivo: string }> = [];
    let feitas = 0;
    try {
      for (const [role, ids] of diferenca.vincular) {
        try {
          const r = await apiClient.post<{ data: ResultadoDoVincular }>(
            `/api/v1/admin/users/${conta.id}/vinculos`,
            { organization_ids: ids, role },
          );
          feitas += r.data.vinculadas.length;
          novasFalhas.push(...r.data.falhas);
        } catch (err) {
          for (const id of ids) novasFalhas.push({ organization_id: id, motivo: mensagemDoErro(err) });
        }
      }
      for (const m of diferenca.trocarPapel) {
        try {
          await apiClient.patch(`/api/v1/admin/users/${conta.id}/vinculos`, m);
          feitas++;
        } catch (err) {
          novasFalhas.push({ organization_id: m.organization_id, motivo: mensagemDoErro(err) });
        }
      }
      for (const orgId of diferenca.desvincular) {
        try {
          await apiClient.delete(
            `/api/v1/admin/users/${conta.id}/vinculos?organization_id=${encodeURIComponent(orgId)}`,
          );
          feitas++;
        } catch (err) {
          novasFalhas.push({ organization_id: orgId, motivo: mensagemDoErro(err) });
        }
      }
    } finally {
      setFalhas(novasFalhas);
      setSalvando(false);
      await queryClient.invalidateQueries({ queryKey: chave });
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    }
    if (novasFalhas.length === 0) {
      toast.success(t("Vínculos salvos."));
    } else {
      toast.error(
        t("{feitas} alteração(ões) salva(s); {falhas} não puderam ser feitas.")
          .replace("{feitas}", String(feitas))
          .replace("{falhas}", String(novasFalhas.length)),
      );
    }
  }

  const nomeDaEmpresa = (id: string) => empresas.find((e) => e.id === id)?.display_name ?? id;

  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-lg" />;
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">{t("Não foi possível carregar os vínculos desta conta.")}</p>;
  }

  const marcadas = [...tela.values()].filter((m) => m.marcada).length;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-sm font-medium">
          {t("2. Marque as empresas que esta conta acessa")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("Vínculo direto: a pessoa ganha acesso na hora, sem e-mail de convite.")}{" "}
          <Link href={`/admin/users/${conta.id}`} className="text-accent hover:underline">
            {t("Abrir ficha da conta")}
          </Link>
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Input
              aria-label={t("Filtrar empresas")}
              placeholder={t("Filtrar empresas")}
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t("Papel nas empresas marcadas agora")}</span>
            <Select value={papelPadrao} onValueChange={(v) => setPapelPadrao(v as Role)}>
              <SelectTrigger className="w-[150px]" aria-label={t("Papel nas empresas marcadas agora")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAPEIS.map((p) => (
                  <SelectItem key={p.valor} value={p.valor}>
                    {t(p.rotulo)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => marcarVisiveis(true)}>
            {filtro ? t("Marcar as filtradas") : t("Marcar todas")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => marcarVisiveis(false)}>
            {filtro ? t("Desmarcar as filtradas") : t("Desmarcar todas")}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("{marcadas} de {total} empresa(s) marcada(s).")
            .replace("{marcadas}", String(marcadas))
            .replace("{total}", String(empresas.length))}
        </p>

        <div className="max-h-[480px] divide-y overflow-auto rounded-md border">
          {visiveis.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">{t("Nenhuma empresa encontrada.")}</p>
          ) : (
            visiveis.map((e) => {
              const marca = tela.get(e.id) ?? { marcada: false, papel: papelPadrao };
              const status = statusGravado.get(e.id);
              return (
                <div key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={marca.marcada}
                      onChange={(ev) => marcar(e.id, ev.target.checked)}
                      aria-label={e.display_name}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{e.display_name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{e.slug}</span>
                    </span>
                  </label>
                  {e.status !== "active" && <Badge variant="warning">{t("Suspensa")}</Badge>}
                  {status === "ativo" && <Badge variant="success">{t("Vinculada")}</Badge>}
                  {status === "revogado" && <Badge variant="neutral">{t("Revogada")}</Badge>}
                  <Select
                    value={marca.papel}
                    onValueChange={(v) => trocarPapel(e.id, v as Role)}
                    disabled={!marca.marcada}
                  >
                    <SelectTrigger className="w-[130px]" aria-label={t("Papel em {empresa}").replace("{empresa}", e.display_name)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAPEIS.map((p) => (
                        <SelectItem key={p.valor} value={p.valor}>
                          {t(p.rotulo)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })
          )}
        </div>

        {falhas.length > 0 && (
          <div className="space-y-1 rounded-md border border-destructive/40 p-3" role="alert">
            <p className="text-sm font-medium text-destructive">{t("Não foi possível alterar:")}</p>
            <ul className="space-y-0.5 text-xs">
              {falhas.map((f) => (
                <li key={f.organization_id}>
                  <strong>{nomeDaEmpresa(f.organization_id)}</strong> — {f.motivo}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={mudancas === 0 || salvando}
            onClick={() => setTela(marcasDoGravado())}
          >
            {t("Descartar")}
          </Button>
          <Button type="button" disabled={mudancas === 0 || salvando} onClick={salvar}>
            {salvando
              ? t("Salvando…")
              : t("Salvar {n} alteração(ões)").replace("{n}", String(mudancas))}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export function VinculosClient() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const usuarioDaUrl = searchParams.get("usuario");

  // A conta escolhida mora na URL (`?usuario=`): a ficha do usuário linka direto
  // para cá, e o F5 não perde a escolha.
  const { data: contaDaUrl } = useQuery({
    queryKey: ["admin", "user", usuarioDaUrl],
    enabled: !!usuarioDaUrl,
    queryFn: () =>
      apiClient.get<{ data: { user: { id: string; email: string | null; full_name: string | null } } }>(
        `/api/v1/admin/users/${usuarioDaUrl}`,
      ),
  });
  const conta: Conta | null = contaDaUrl?.data.user
    ? {
        id: contaDaUrl.data.user.id,
        email: contaDaUrl.data.user.email,
        full_name: contaDaUrl.data.user.full_name,
      }
    : null;

  const escolher = (c: Conta) => {
    router.replace(`${pathname}?usuario=${c.id}`);
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <LinkIcon size={24} aria-hidden className="text-muted-foreground" />
          {t("Vínculos")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("Escolha quais empresas cada conta acessa: uma, algumas ou todas, com o papel de cada uma.")}
        </p>
      </header>

      <BuscaDeConta onEscolher={escolher} />

      {usuarioDaUrl && !conta && <Skeleton className="h-64 w-full rounded-lg" />}
      {conta && (
        <div className="space-y-2">
          <p className="text-sm">
            {t("Conta:")} <strong>{conta.full_name ?? conta.email}</strong>
            {conta.full_name && conta.email && (
              <span className="ml-2 font-mono text-xs text-muted-foreground">{conta.email}</span>
            )}
          </p>
          <EmpresasDaConta key={conta.id} conta={conta} />
        </div>
      )}
    </div>
  );
}
