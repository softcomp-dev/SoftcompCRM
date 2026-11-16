/**
 * O NÚMERO DA COTAÇÃO OU DO PEDIDO NA EDIÇÃO DO NEGÓCIO (migration 9260).
 *
 * Nos dois formulários de edição (diálogo do funil e dossiê): a pessoa digita
 * o número e escolhe Cotação OU Pedido — a escolha é exclusiva, um rádio só
 * fica marcado —, e o PATCH leva o par. Apagar o número limpa o par inteiro.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
const editar = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, role: "agent", orgId: "org-1" }),
  useAuth: () => ({ user: { id: "usuario-eu" }, activeOrg: null }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/inbox/ContactTagsEditor", () => ({ ContactTagsEditor: () => null }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync: editar.mutateAsync, isPending: false }),
}));

import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";

const FUNIL = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";

function negocio(documento: { kind: "quote" | "order" | null; number: string | null }) {
  return {
    id: LEAD_ID,
    organization_id: "org-1",
    pipeline_id: FUNIL,
    stage_id: "22222222-2222-4222-8222-222222222222",
    title: "Pedido de peças",
    description: null,
    value_cents: 100000,
    recurring_value_cents: null,
    recurring_period: null,
    recurring_months: null,
    sales_document_kind: documento.kind,
    sales_document_number: documento.number,
    currency: "BRL",
    expected_close_date: null,
    tags: [],
    custom_fields: {},
  } as never;
}

function comQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function patchGravado(): Record<string, unknown> {
  const chamada = editar.mutateAsync.mock.calls[0];
  if (!chamada) throw new Error("o formulário não chamou a gravação");
  return (chamada[0] as { patch: Record<string, unknown> }).patch;
}

const FORMULARIOS: Array<[string, (lead: never) => ReactElement]> = [
  ["EditLeadDialog (funil)", (lead) => <EditLeadDialog open onOpenChange={() => {}} lead={lead} pipelineId={FUNIL} />],
  ["LeadFieldsForm (dossiê)", (lead) => <LeadFieldsForm lead={lead} pipelineId={FUNIL} />],
];

beforeEach(() => {
  editar.mutateAsync.mockReset();
  editar.mutateAsync.mockResolvedValue({ lead: { id: LEAD_ID } });
  Object.values(toastMock).forEach((f) => f.mockReset());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("número da cotação ou do pedido na edição do negócio", () => {
  it.each(FORMULARIOS)("%s: digitar o número e escolher Pedido grava o par", async (_nome, montar) => {
    const user = userEvent.setup();
    comQuery(montar(negocio({ kind: null, number: null })));

    const cotacao = screen.getByRole("radio", { name: "Cotação" });
    const pedido = screen.getByRole("radio", { name: "Pedido" });
    // Sem documento, a tela sugere cotação.
    expect(cotacao).toHaveAttribute("aria-checked", "true");
    expect(pedido).toHaveAttribute("aria-checked", "false");

    await user.type(screen.getByLabelText("Número da cotação ou do pedido"), " PV-000123 ");
    await user.click(pedido);
    // Exclusivo: marcar um desmarca o outro.
    expect(pedido).toHaveAttribute("aria-checked", "true");
    expect(cotacao).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(editar.mutateAsync).toHaveBeenCalled());
    expect(patchGravado()).toMatchObject({
      sales_document_kind: "order",
      sales_document_number: "PV-000123",
    });
  });

  it.each(FORMULARIOS)("%s: abre com o documento gravado e apagar o número limpa o par", async (_nome, montar) => {
    const user = userEvent.setup();
    comQuery(montar(negocio({ kind: "order", number: "PV-77" })));

    expect(screen.getByLabelText("Número da cotação ou do pedido")).toHaveValue("PV-77");
    expect(screen.getByRole("radio", { name: "Pedido" })).toHaveAttribute("aria-checked", "true");

    await user.clear(screen.getByLabelText("Número da cotação ou do pedido"));
    await user.click(screen.getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(editar.mutateAsync).toHaveBeenCalled());
    expect(patchGravado()).toMatchObject({ sales_document_kind: null, sales_document_number: null });
  });
});
