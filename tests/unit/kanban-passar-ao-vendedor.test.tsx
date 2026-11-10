import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { AssignableMember } from "@/hooks/inbox/useAssignableMembers";
import type { Lead } from "@/lib/types/leads";

/**
 * "Passar para vendedor" no menu do card do funil (docs/features/sdr.md): o SDR
 * escolhe o vendedor que vai fechar. O item só existe para SDR ativo, só no
 * negócio que é dele ou está sem dono humano, e só lista quem a rota
 * `/api/v1/sdr/vendedores` disse que pode receber — nunca outro SDR.
 */

const SDR = "u-sdr";
const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { post, get, patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => chave === "pipeline.move_card",
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/usePropostaEnviadaDoLead", () => ({
  usePropostaEnviadaDoLead: () => ({ data: undefined }),
}));
const membros: AssignableMember[] = [
  { user_id: SDR, role: "agent", full_name: "Sara SDR" },
  { user_id: "u-outro-sdr", role: "agent", full_name: "Otávio SDR" },
  { user_id: "u-vend", role: "agent", full_name: "Vera Vendedora" },
];
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: membros }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));

const lead = (owner: string | null) =>
  ({ id: "l-1", title: "Proposta da ACME", owner_user_id: owner, owner_agent_id: null }) as unknown as Lead;

function renderCard(owner: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="group">
        <KanbanCardActions lead={lead(owner)} pipelineId="p-1" />
      </div>
    </QueryClientProvider>,
  );
}

function comoSdr(pode: boolean) {
  get.mockImplementation(async (url: string) =>
    url === "/api/v1/sdr/vendedores"
      ? { data: { user_id: SDR, pode_passar: pode, motivo: pode ? null : "not_assigned", vendedores: pode ? ["u-vend"] : [] } }
      : { data: [] },
  );
}

async function abrirMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
  await screen.findByRole("menuitem", { name: "Editar" });
}

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  vi.clearAllMocks();
});

describe("menu do card — Passar para vendedor", () => {
  it("o SDR vê só os vendedores e a escolha chama a passagem com o vendedor", async () => {
    comoSdr(true);
    post.mockResolvedValue({
      data: { lead_id: "l-1", owner_user_id: "u-vend", carteira: "passou", carteira_motivo: null, conversas_passadas: 1, conversas_que_ficaram: 0 },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderCard(SDR);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/sdr/vendedores"));
    await abrirMenu(user);

    await user.hover(await screen.findByRole("menuitem", { name: "Passar para vendedor" }));
    const sub = await screen.findByRole("menu", { name: "Passar para vendedor" });
    expect(sub.textContent).toContain("Vera Vendedora");
    expect(sub.textContent).not.toContain("Otávio SDR");
    expect(sub.textContent).not.toContain("Sara SDR");

    // Clique direto no item: no jsdom não há geometria, e o movimento do ponteiro
    // até o submenu o fecha antes do clique (a "área de tolerância" do Radix).
    fireEvent.click(screen.getByRole("menuitem", { name: "Vera Vendedora" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/leads/l-1/passar-ao-vendedor", { user_id: "u-vend" }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Negócio passado para Vera Vendedora."));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("quando a carteira não passa, o SDR é avisado", async () => {
    comoSdr(true);
    post.mockResolvedValue({
      data: { lead_id: "l-1", owner_user_id: "u-vend", carteira: "nao_passou", carteira_motivo: "cliente_de_outro_vendedor", conversas_passadas: 0, conversas_que_ficaram: 0 },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderCard(null);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/sdr/vendedores"));
    await abrirMenu(user);
    await user.hover(await screen.findByRole("menuitem", { name: "Passar para vendedor" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Vera Vendedora" }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  });

  it("quem não é SDR não vê o item", async () => {
    comoSdr(false);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderCard(SDR);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/sdr/vendedores"));
    await abrirMenu(user);
    expect(screen.queryByRole("menuitem", { name: "Passar para vendedor" })).toBeNull();
  });

  it("no negócio de um colega o SDR não vê o item", async () => {
    comoSdr(true);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderCard("u-colega");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/sdr/vendedores"));
    await abrirMenu(user);
    expect(screen.queryByRole("menuitem", { name: "Passar para vendedor" })).toBeNull();
  });
});
