// components/kanban/PropostasDoNegocio.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropostasDoNegocio } from "./PropostasDoNegocio";
import { apiClient } from "@/lib/api/client";

vi.mock("@/lib/api/client");
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

/** A lista (`?lead_id=`) e o detalhe (`/proposals/<id>`) são rotas diferentes. */
function responder(lista: unknown[], detalhe: unknown = null) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
    (url.includes("?lead_id=") ? { data: lista } : { data: detalhe }) as never,
  );
}

function renderComQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("PropostasDoNegocio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lista as propostas com número/versão/status/total/validade", async () => {
    responder([{ id: "p1", titulo: "Site", status: "enviada", total_cents: 500000, moeda: "BRL", numero: 42, ano: 2026, versao: 1, valid_until: "2026-10-01", created_at: "2026-09-01" }]);
    renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" />);
    expect(await screen.findByText(/0042\/2026/)).toBeInTheDocument();
  });

  it("sem propostas: mostra o atalho 'Nova proposta', nunca uma lista vazia muda (manager+)", async () => {
    responder([]);
    renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" podeCriar />);
    expect(await screen.findByRole("link", { name: /nova proposta/i })).toBeInTheDocument();
  });

  it("papel sem permissão de criar: não mostra o atalho", async () => {
    responder([]);
    renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" podeCriar={false} />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /nova proposta/i })).not.toBeInTheDocument();
  });

  describe("itens da proposta vigente (9261)", () => {
    const PROPOSTA = { titulo: "Aço", total_cents: 7432, moeda: "BRL", numero: 7, ano: 2026, versao: 1, valid_until: null, created_at: "2026-11-18" };
    const ITEM = { quantidade: 4, preco_unitario_cents: 929, desconto_cents: 0 };
    const detalhe = (status: string, fase: string | null, a: string, b: string) => ({
      id: "p2", status, moeda: "BRL", total_cents: 7432, fase_dos_itens: fase,
      itens: [
        { ...ITEM, id: "i1", descricao: "1020 REDONDO LAMINADO 200.00 x 45", status: a },
        { ...ITEM, id: "i2", descricao: "1045 REDONDO LAMINADO 200.00 x 45", status: b },
      ],
    });

    it("mostra a tabela da proposta mais recente que ainda vale, pulando a substituída", async () => {
      responder(
        [
          { ...PROPOSTA, id: "p2", status: "enviada", versao: 2 },
          { ...PROPOSTA, id: "p1", status: "substituida" },
        ],
        detalhe("enviada", "cotacao", "pendente", "pendente"),
      );
      renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" podeDecidirItens />);
      expect(await screen.findByText("1020 REDONDO LAMINADO 200.00 x 45")).toBeInTheDocument();
      expect(apiClient.get).toHaveBeenCalledWith("/api/v1/proposals/p2");
      for (const coluna of ["Descrição", "Valor unitário", "Quantidade", "Total", "Status"]) {
        expect(screen.getByRole("columnheader", { name: coluna })).toBeInTheDocument();
      }
      // 4 × R$ 9,29 = R$ 37,16 por linha.
      expect(screen.getAllByText(/37,16/)).toHaveLength(2);
      expect(screen.getAllByRole("combobox", { name: "Status do item" })).toHaveLength(2);
    });

    it("sem papel para decidir: só os selos", async () => {
      responder([{ ...PROPOSTA, id: "p2", status: "enviada" }], detalhe("enviada", "cotacao", "aceito", "pendente"));
      renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" podeDecidirItens={false} />);
      expect(await screen.findByText("Aceito")).toBeInTheDocument();
      expect(screen.getByText("Pendente")).toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });

    it("pedido: o item aceito oferece produção e entrega", async () => {
      responder([{ ...PROPOSTA, id: "p2", status: "aceita" }], detalhe("aceita", "pedido", "em_producao", "recusado"));
      renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" podeDecidirItens />);
      const [seletor] = await screen.findAllByRole("combobox", { name: "Status do item" });
      expect((seletor as HTMLSelectElement).value).toBe("em_producao");
      expect([...(seletor as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Aceito", "Em produção", "Entregue"]);
      expect(screen.getByText("Recusado")).toBeInTheDocument();
    });

    it("só propostas canceladas: nenhuma tabela", async () => {
      responder([{ ...PROPOSTA, id: "p1", status: "cancelada" }]);
      renderComQuery(<PropostasDoNegocio leadId="lead-1" pipelineId="pipe-1" podeDecidirItens />);
      await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });
  });
});
