import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import type { Lead } from "@/lib/types/leads";

/**
 * "Transferir para outra empresa" no menu do card: só para quem tem acesso a
 * mais de uma empresa com papel suficiente (regra em
 * `lib/leads/transferir-entre-empresas.ts`, `podeTransferirEntreEmpresas`), e
 * só para negócio em andamento — a rota recusa o encerrado.
 */

const estado = vi.hoisted(() => ({ podeTransferir: true, abriu: false }));

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(async () => ({ data: [] })), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: () => null,
}));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/hooks/kanban/usePodeTransferirEntreEmpresas", () => ({
  usePodeTransferirEntreEmpresas: () => estado.podeTransferir,
}));
vi.mock("@/components/kanban/TransferToOrganizationDialog", () => ({
  TransferToOrganizationDialog: ({ open }: { open: boolean }) => {
    if (open) estado.abriu = true;
    return open ? <div>diálogo de transferência</div> : null;
  },
}));

function renderMenu(status = "open") {
  const lead = {
    id: "l-1",
    title: "Pedido 42",
    status,
    owner_user_id: null,
    owner_agent_id: null,
  } as unknown as Lead;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KanbanCardActions lead={lead} pipelineId="p-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  estado.podeTransferir = true;
  estado.abriu = false;
});

describe("menu do card — Transferir para outra empresa", () => {
  it("abre o diálogo para quem pode transferir", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await user.click(await screen.findByRole("menuitem", { name: "Transferir para outra empresa" }));
    expect(await screen.findByText("diálogo de transferência")).toBeTruthy();
    expect(estado.abriu).toBe(true);
  });

  it("não aparece para quem tem uma empresa só (ou sem papel)", async () => {
    estado.podeTransferir = false;
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await screen.findByRole("menuitem", { name: "Levar para outro funil" });
    expect(screen.queryByRole("menuitem", { name: "Transferir para outra empresa" })).toBeNull();
  });

  it("não aparece para negócio encerrado", async () => {
    const user = userEvent.setup();
    renderMenu("lost");
    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await screen.findByRole("menuitem", { name: "Levar para outro funil" });
    expect(screen.queryByRole("menuitem", { name: "Transferir para outra empresa" })).toBeNull();
  });
});
