import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildCardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

import { KanbanCard } from "./KanbanCard";

/**
 * GANHO, PERDIDO E GANHO PARCIAL (migration 9259) — cada desfecho pinta o card
 * com a sua cor: faixa lateral e fundo leve. Aberto fica como sempre.
 *
 * Prova na ÁRVORE (classes e `data-desfecho`); a cor medida em pixel é do e2e.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "o-1", currency: "BRL" }),
}));
// Os diálogos do menu de ações não fazem parte desta medida: o que se olha aqui
// é o CORPO do card. Dublados, eles não arrastam a org, a moeda e as rotas de
// cada um para dentro do caso.
vi.mock("./EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("./LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("./MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
  useWinPartialLead: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

const AGORA = new Date("2026-10-27T12:00:00Z");
/** 5 dias parado na etapa: dá idade para o rodapé escrever "5d em Negociação". */
const ENTRADA_NA_ETAPA = "2026-10-22T12:00:00Z";

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME — renovação anual de contrato",
  value_cents: 250_000,
  currency: "BRL",
  tags: ["vip"],
  stage_changed_at: ENTRADA_NA_ETAPA,
  created_at: ENTRADA_NA_ETAPA,
  owner_kind: "user",
  owner_user_id: "u-1",
  owner_agent_id: null,
  owner_agent: null,
  owner_user: { full_name: "Marcos" },
  next_action: null,
  score: null,
  contact_id: "c-1",
  contact_phone: "+55 11 98888-7777",
  contact_email: "ana@exemplo.com",
  contact_links: [],
  conversa: {
    id: "conv-1",
    preview: "Quero saber o preço",
    last_message_at: "2026-10-26T10:00:00Z",
    unread: 0,
  },
  tarefas: [],
} as unknown as Lead;

function montar(denso: boolean, extra: Partial<Lead> = {}) {
  const lead = { ...LEAD, ...extra } as Lead;
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const card = buildCardInput(lead, {
    stageName: "Negociação",
    ownerNames: new Map([["u-1", "Marcos"]]),
    coolingIds: new Set<string>(),
    reactivations: new Map(),
    canonicalTags: [],
    now: AGORA,
  });
  return render(
    <QueryClientProvider client={cliente}>
      <DragDropContext onDragEnd={() => undefined}>
        <Droppable droppableId="etapa-1" type="LEAD">
          {() => (
            <div>
              <KanbanCard
                card={card}
                lead={lead}
                index={0}
                pipelineId="p-1"
                etapas={[]}
                denso={denso}
              />
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </QueryClientProvider>,
  );
}


function cartao(container: HTMLElement) {
  return container.querySelector('[role="group"]') as HTMLElement;
}

describe("cor do desfecho no card", () => {
  it("aberto: sem desfecho, sem fundo, faixa de estado de sempre", () => {
    const { container } = montar(false, { status: "open" } as Partial<Lead>);
    expect(cartao(container).getAttribute("data-desfecho")).toBeNull();
    expect(container.querySelector("[data-fundo-do-desfecho]")).toBeNull();
  });

  it.each([
    ["won", false, "ganho", "bg-success", "bg-success-bg"],
    ["lost", false, "perdido", "bg-error", "bg-error-bg"],
    ["won", true, "parcial", "bg-warning", "bg-warning-bg"],
  ] as const)("status %s, parcial %s → %s, faixa %s e fundo %s", (status, parcial, desfecho, faixa, fundo) => {
    const { container } = montar(false, { status, is_partial_win: parcial } as Partial<Lead>);
    expect(cartao(container).getAttribute("data-desfecho")).toBe(desfecho);
    expect(container.querySelector("[data-faixa-de-estado]")).toHaveClass(faixa);
    expect(container.querySelector("[data-fundo-do-desfecho]")).toHaveClass(fundo);
  });

  it("o leitor de tela ouve o desfecho junto do título", () => {
    const { container } = montar(false, { status: "won", is_partial_win: true } as Partial<Lead>);
    expect(cartao(container).getAttribute("aria-label")).toContain("(Ganho parcial)");
  });
});
