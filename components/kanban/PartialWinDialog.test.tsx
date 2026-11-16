import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PartialWinDialog } from "./PartialWinDialog";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
const mutateAsync = vi.fn(async () => ({}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinPartialLead: () => ({ mutateAsync, isPending: false }),
}));

const LEAD = {
  id: "l-1",
  title: "Pedido da ACME",
  value_cents: 100_000,
  currency: "BRL",
  is_partial_win: false,
  partial_original_value_cents: null,
};

function montar(onOpenChange = vi.fn()) {
  render(<PartialWinDialog open onOpenChange={onOpenChange} pipelineId="p-1" lead={LEAD} />);
  return {
    valor: screen.getByLabelText(/Valor fechado/),
    motivo: screen.getByLabelText("Motivo"),
    confirmar: screen.getByRole("button", { name: "Confirmar" }),
    onOpenChange,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("diálogo do ganho parcial", () => {
  it("mostra o valor previsto", () => {
    montar();
    expect(screen.getByText(/Previsto/)).toHaveTextContent("1.000,00");
  });

  it("valor igual ao previsto é recusado antes do clique", () => {
    const { valor, motivo, confirmar } = montar();
    fireEvent.change(valor, { target: { value: "1000" } });
    fireEvent.change(motivo, { target: { value: "metade" } });
    expect(screen.getByRole("alert")).toHaveTextContent("menor que o previsto");
    expect(confirmar).toBeDisabled();
  });

  it("sem motivo não confirma", () => {
    const { valor, confirmar } = montar();
    fireEvent.change(valor, { target: { value: "600" } });
    expect(confirmar).toBeDisabled();
  });

  it("valor e motivo válidos enviam o valor em centavos e fecham", async () => {
    const { valor, motivo, confirmar, onOpenChange } = montar();
    fireEvent.change(valor, { target: { value: "600,50" } });
    fireEvent.change(motivo, { target: { value: "  Levou só parte  " } });
    fireEvent.click(confirmar);
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mutateAsync).toHaveBeenCalledWith({ leadId: "l-1", valueCents: 60_050, reason: "Levou só parte" });
  });
});
