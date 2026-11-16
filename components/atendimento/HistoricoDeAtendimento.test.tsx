import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ItemDoHistoricoView, NegocioDoContato } from "@/lib/atendimento/historico";

/**
 * A aba "Atendimentos" da ficha do contato e o diálogo "Registrar interação".
 * Os hooks de dados são trocados por dublês: o que se mede aqui é a TELA — o
 * que aparece, o que o filtro esconde, quem vê o botão e o que o diálogo manda.
 */
const mutateAsync = vi.hoisted(() => vi.fn(async () => ({ data: { id: "act-1" } })));
const historico = vi.hoisted(() => ({ atual: null as unknown }));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/atendimento/useHistoricoDeAtendimento", () => ({
  useHistoricoDeAtendimento: () => historico.atual,
  useRegistrarInteracao: () => ({ mutateAsync, isPending: false }),
}));

import { HistoricoDeAtendimento } from "./HistoricoDeAtendimento";
import { negocioPadrao } from "./RegistrarInteracaoDialog";

const base: Omit<ItemDoHistoricoView, "id" | "source" | "channel" | "started_at"> = {
  direction: "outbound",
  ended_at: null,
  duration_seconds: null,
  outcome: null,
  summary: null,
  lead_id: null,
  conversation_id: null,
  activity_type: null,
  handled_by_ai: false,
  team: [],
  messages: null,
};

const itens: ItemDoHistoricoView[] = [
  {
    ...base,
    id: "chat:conv-1:2026-11-12",
    source: "chat",
    channel: "whatsapp_chat",
    direction: "inbound",
    started_at: "2026-11-12T12:00:00.000Z",
    ended_at: "2026-11-12T12:30:00.000Z",
    conversation_id: "conv-1",
    team: [{ user_id: "u1", name: "Ana Souza" }],
    messages: { from_contact: 3, from_team: 2, from_ai: 0, automated: 0 },
  },
  {
    ...base,
    id: "call:c1",
    source: "call",
    channel: "voip",
    started_at: "2026-11-11T14:00:00.000Z",
    duration_seconds: 600,
    outcome: "talked",
    lead_id: "lead-1",
  },
  {
    ...base,
    id: "record:a1",
    source: "record",
    channel: "visit",
    started_at: "2026-11-10T15:00:00.000Z",
    outcome: "talked",
    summary: "Visitou a loja e levou o catálogo",
    team: [{ user_id: "u2", name: "Bruno Lima" }],
  },
];

const leads: NegocioDoContato[] = [
  { id: "lead-velho", title: "Pedido antigo", status: "won", pipeline_name: "Vendas", last_activity_at: "2026-12-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
  { id: "lead-1", title: "Reforma da cozinha", status: "open", pipeline_name: "Vendas", last_activity_at: "2026-11-11T00:00:00.000Z", created_at: "2026-11-01T00:00:00.000Z" },
  { id: "lead-2", title: "Armário", status: "open", pipeline_name: null, last_activity_at: null, created_at: "2026-10-01T00:00:00.000Z" },
];

function comDados(items: ItemDoHistoricoView[], negocios: NegocioDoContato[] = leads) {
  historico.atual = {
    data: { pages: [{ data: { items, leads: negocios } }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  comDados(itens);
});

describe("HistoricoDeAtendimento", () => {
  it("mostra chat, ligação e registro, com quem atendeu, o texto registrado e o link da conversa", () => {
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar />);
    expect(screen.getAllByTestId("item-do-historico")).toHaveLength(3);
    expect(screen.getByText("Conversa no WhatsApp")).toBeTruthy();
    expect(screen.getByText("3 do cliente · 2 da equipe", { exact: false })).toBeTruthy();
    expect(screen.getByText("Ana Souza")).toBeTruthy();
    expect(screen.getByText("Visitou a loja e levou o catálogo")).toBeTruthy();
    expect(screen.getByText("Negócio: Reforma da cozinha")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Abrir conversa/ }).getAttribute("href")).toBe("/app/inbox?id=conv-1");
  });

  it("o filtro deixa só a origem escolhida", () => {
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar />);
    fireEvent.click(screen.getByRole("button", { name: "Ligações" }));
    const visiveis = screen.getAllByTestId("item-do-historico");
    expect(visiveis.map((v) => v.getAttribute("data-source"))).toEqual(["call"]);
  });

  it("quem só lê não vê o botão de registrar", () => {
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar={false} />);
    expect(screen.queryByRole("button", { name: /Registrar interação/ })).toBeNull();
  });

  it("sem atendimento nenhum, diz de onde os itens vêm", () => {
    comDados([]);
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar />);
    expect(screen.getByText(/Ainda não há atendimento com este contato/)).toBeTruthy();
  });
});

describe("RegistrarInteracaoDialog", () => {
  it("vem com o negócio aberto mais recente e manda o registro com o texto aparado", async () => {
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar />);
    fireEvent.click(screen.getByRole("button", { name: /Registrar interação/ }));
    const dialogo = screen.getByRole("dialog");
    fireEvent.change(within(dialogo).getByLabelText("O que foi conversado"), {
      target: { value: "  Liguei do celular, pediu desconto  " },
    });
    fireEvent.change(within(dialogo).getByLabelText("Duração em minutos (opcional)"), { target: { value: "8" } });
    fireEvent.click(within(dialogo).getByRole("button", { name: "Registrar" }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const [pedido] = mutateAsync.mock.calls[0] as unknown as [{ input: Record<string, unknown>; chave: string }];
    expect(pedido.input).toMatchObject({
      lead_id: "lead-1",
      channel: "phone",
      direction: "outbound",
      outcome: "talked",
      summary: "Liguei do celular, pediu desconto",
      duration_minutes: 8,
    });
    expect(typeof pedido.input.occurred_at).toBe("string");
    expect(pedido.chave).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("data no futuro não sai do navegador, e o diálogo diz por quê", () => {
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar />);
    fireEvent.click(screen.getByRole("button", { name: /Registrar interação/ }));
    const dialogo = screen.getByRole("dialog");
    fireEvent.change(within(dialogo).getByLabelText("O que foi conversado"), { target: { value: "ok" } });
    fireEvent.change(within(dialogo).getByLabelText("Quando"), { target: { value: "2099-01-01T10:00" } });
    fireEvent.click(within(dialogo).getByRole("button", { name: "Registrar" }));
    expect(within(dialogo).getByRole("alert").textContent).toContain("não pode estar no futuro");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("sem resumo o botão fica desligado; sem negócio, o diálogo diz o que fazer", () => {
    comDados(itens, []);
    render(<HistoricoDeAtendimento contactId="ct-1" podeRegistrar />);
    fireEvent.click(screen.getByRole("button", { name: /Registrar interação/ }));
    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByRole("alert").textContent).toContain("ainda não tem negócio");
    expect((within(dialogo).getByRole("button", { name: "Registrar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("negocioPadrao", () => {
  it("prefere o aberto com movimento mais recente; sem aberto, o primeiro da lista", () => {
    expect(negocioPadrao(leads)).toBe("lead-1");
    expect(negocioPadrao([leads[0]!])).toBe("lead-velho");
    expect(negocioPadrao([])).toBe("");
  });
});
