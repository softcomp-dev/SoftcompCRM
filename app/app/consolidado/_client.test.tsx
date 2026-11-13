/**
 * Visão consolidada — arrastar para uma etapa que exige campos (ou o motivo do
 * ganho) abre o MESMO diálogo do quadro, em vez de só mostrar erro, e o reenvio
 * leva os valores na mesma escrita. Campo de arquivo não cabe aqui (o anexo
 * sobe pela empresa ativa): a tela oferece abrir o negócio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/consolidado",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn(async () => ({ ok: true })) }));

import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

import { ConsolidadoClient } from "./_client";

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const FUNIL = "f0000000-0000-4000-8000-000000000001";
const NOVO = "e0000000-0000-4000-8000-00000000000a";
const GANHO = "e0000000-0000-4000-8000-00000000000b";
const LEAD = "d0000000-0000-4000-8000-000000000001";

const funil = {
  empresas: [
    { organization_id: ORG, nome: "Matriz", role: "admin" },
    { organization_id: OUTRA, nome: "Filial", role: "agent" },
  ],
  escopo: [ORG, OUTRA],
  funis_oferecidos: [],
  funil: "padrao",
  funis: [{ id: FUNIL, organization_id: OUTRA, name: "Vendas", motivos_de_perda: [] }],
  colunas: [
    { chave: "novo", rotulo: "Novo", tipo: "aberta", etapas: [{ stage_id: NOVO, pipeline_id: FUNIL, organization_id: OUTRA }] },
    { chave: "__ganho", rotulo: "Ganho", tipo: "ganho", etapas: [{ stage_id: GANHO, pipeline_id: FUNIL, organization_id: OUTRA }] },
  ],
  negocios: [
    {
      id: LEAD,
      organization_id: OUTRA,
      pipeline_id: FUNIL,
      stage_id: NOVO,
      title: "Pedido 42",
      status: "open",
      value_cents: 10000,
      currency: "BRL",
      position_in_stage: 1,
      updated_at: "2026-11-13T00:00:00.000Z",
    },
  ],
  truncados: [],
  etapas_truncadas: [],
};

function arrastarParaGanho() {
  const card = screen.getByTestId("card-consolidado");
  const transferencia = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(card, { dataTransfer: transferencia });
  const coluna = document.querySelector('[data-coluna="__ganho"]') as HTMLElement;
  fireEvent.dragOver(coluna, { dataTransfer: transferencia });
  fireEvent.drop(coluna, { dataTransfer: transferencia });
}

function renderizar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConsolidadoClient empresaAtiva={ORG} emSuporte={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: funil } as never);
});

describe("arrastar para etapa que exige dados", () => {
  it("abre o diálogo e reenvia o MESMO movimento com o motivo e os campos", async () => {
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(
        new ApiError(
          422,
          "required_fields_missing",
          {
            faltando: [
              { chave: "won_reason", rotulo: "Motivo do ganho" },
              { chave: "pedido", rotulo: "Número do pedido", tipo: "text" },
            ],
          },
          "r",
          "Faltam campos.",
        ),
      )
      .mockResolvedValueOnce({ data: { id: LEAD } } as never);
    renderizar();
    await screen.findByText("Pedido 42");

    arrastarParaGanho();

    await screen.findByText("Campos obrigatórios");
    expect(toast.error).not.toHaveBeenCalled();
    const usuario = userEvent.setup();
    await usuario.type(screen.getByLabelText(/Motivo do ganho/), "Fechou à vista");
    await usuario.type(screen.getByLabelText(/Número do pedido/), "PV-9");
    await usuario.click(screen.getByRole("button", { name: "Mover agora" }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiClient.post).mock.calls[1]).toEqual([
      "/api/v1/consolidado/funil/mover",
      { lead_id: LEAD, stage_id: GANHO, won_reason: "Fechou à vista", custom_fields: { pedido: "PV-9" } },
    ]);
  });

  it("campo de arquivo não abre o diálogo: oferece abrir o negócio na empresa dele", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(
      new ApiError(422, "required_fields_missing", { faltando: [{ chave: "nf", rotulo: "Nota", tipo: "file" }] }, "r", "x"),
    );
    renderizar();
    await screen.findByText("Pedido 42");

    arrastarParaGanho();

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [, opcoes] = vi.mocked(toast.warning).mock.calls[0] as unknown as [string, { action: { label: string } }];
    expect(opcoes.action.label).toBe("Abrir o negócio");
    expect(screen.queryByText("Campos obrigatórios")).toBeNull();
  });

  it("recusa que não é de campos segue no aviso de erro", async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new ApiError(403, "forbidden", undefined, "r", "Sem permissão."));
    renderizar();
    await screen.findByText("Pedido 42");

    arrastarParaGanho();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sem permissão."));
  });
});
