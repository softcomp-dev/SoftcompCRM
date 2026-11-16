"use client";

import type { UseFormRegisterReturn } from "react-hook-form";
import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  TAMANHO_MAXIMO_DO_NUMERO,
  TIPOS_DE_DOCUMENTO_DE_VENDA,
  type TipoDeDocumentoDeVenda,
} from "@/lib/leads/documento-de-venda";

interface Props {
  /** Prefixo dos ids, para o diálogo e o dossiê poderem conviver na mesma tela. */
  idBase: string;
  tipo: TipoDeDocumentoDeVenda;
  onTipoChange: (tipo: TipoDeDocumentoDeVenda) => void;
  numero: UseFormRegisterReturn;
  erro?: string;
  disabled?: boolean;
}

/**
 * O número da COTAÇÃO ou do PEDIDO do negócio (migration 9260).
 *
 * A escolha é exclusiva — o negócio é uma coisa OU a outra — e por isso é um
 * grupo de rádio, não duas caixas de marcar nem dois campos de número. Apagar
 * o número limpa o documento inteiro, o tipo junto (`documentoParaGravar`).
 */
export function CampoDocumentoDeVenda({ idBase, tipo, onTipoChange, numero, erro, disabled }: Props) {
  const t = useT();
  const idNumero = `${idBase}-numero`;
  const rotulos: Record<TipoDeDocumentoDeVenda, string> = {
    quote: t("Cotação"),
    order: t("Pedido"),
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={idNumero}>
        {t("Número da cotação ou do pedido")}
      </Label>
      <div className="flex gap-2">
        <div
          role="radiogroup"
          aria-label={t("Cotação ou pedido")}
          className="inline-flex shrink-0 rounded-md border border-border p-0.5"
        >
          {TIPOS_DE_DOCUMENTO_DE_VENDA.map((opcao) => (
            <button
              key={opcao}
              type="button"
              role="radio"
              aria-checked={tipo === opcao}
              disabled={disabled}
              onClick={() => onTipoChange(opcao)}
              className={cn(
                "rounded-sm px-3 text-sm transition-colors",
                tipo === opcao
                  ? "bg-accent-soft font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-55",
              )}
            >
              {rotulos[opcao]}
            </button>
          ))}
        </div>
        <Input
          id={idNumero}
          maxLength={TAMANHO_MAXIMO_DO_NUMERO}
          autoComplete="off"
          placeholder={tipo === "order" ? t("Ex.: PV-000123") : t("Ex.: COT-000123")}
          disabled={disabled}
          {...numero}
        />
      </div>
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
    </div>
  );
}
