/**
 * Função SDR na tela de Equipe: o cartão do interruptor e a coluna "SDR".
 *
 * Mede o que a pessoa vê e o que o clique pede ao servidor: desligada, a
 * coluna não existe; ligada, o admin marca/desmarca e o viewer não pode ser
 * marcado; uma marca sem efeito diz por quê; o gerente só lê.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TeamMember } from "@/hooks/team/useTeamMembers";
import type { SdrAssignment } from "@/hooks/sdr/useSdr";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { SdrCard } from "./SdrCard";
import { TeamMembersClient } from "./TeamMembersClient";

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REBAIXADO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function membro(user_id: string, role: string, full_name: string): TeamMember {
  return {
    user_id,
    role,
    invited_at: null,
    accepted_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00Z",
    email: `${full_name.toLowerCase()}@example.com`,
    full_name,
    last_sign_in_at: null,
  };
}

let ligado: boolean;
let atribuidos: SdrAssignment[];

beforeEach(() => {
  vi.clearAllMocks();
  ligado = false;
  atribuidos = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url === "/api/v1/settings/sdr") return { data: { enabled: ligado } };
    if (url === "/api/v1/sdr/assignments") return { data: atribuidos };
    return {
      data: [
        membro(ADMIN, "admin", "Admin"),
        membro(AGENTE, "agent", "Agente"),
        membro(VIEWER, "viewer", "Visual"),
        membro(REBAIXADO, "viewer", "Rebaixado"),
      ],
    };
  }) as never);
  vi.mocked(apiClient.patch).mockResolvedValue({ data: { enabled: true } } as never);
  vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
  vi.mocked(apiClient.delete).mockResolvedValue({ data: {} } as never);
});

function renderizar(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SdrCard", () => {
  it("admin liga a função pelo interruptor", async () => {
    renderizar(<SdrCard canManage />);
    const chave = await screen.findByRole("switch", { name: "Função SDR nesta empresa" });
    await waitFor(() => expect(chave).not.toBeDisabled());
    expect(chave).toHaveAttribute("aria-checked", "false");

    await userEvent.click(chave);
    expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/settings/sdr", { enabled: true });
  });

  it("gerente vê o estado, sem interruptor", async () => {
    ligado = true;
    renderizar(<SdrCard canManage={false} />);
    expect(await screen.findByText("Ligada")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("coluna SDR na tabela da equipe", () => {
  it("com a função desligada, não há coluna nem busca da lista", async () => {
    renderizar(<TeamMembersClient currentUserId={ADMIN} canManage />);
    await screen.findByText("Agente");
    expect(screen.queryByRole("columnheader", { name: "SDR" })).toBeNull();
    expect(vi.mocked(apiClient.get).mock.calls.map(([u]) => u)).not.toContain("/api/v1/sdr/assignments");
  });

  it("admin marca um atendente e desmarca um SDR", async () => {
    ligado = true;
    atribuidos = [
      { user_id: ADMIN, full_name: "Admin", role: "admin", assigned_since: "2026-11-01T00:00:00Z", active: true, inactive_reason: null },
    ];
    renderizar(<TeamMembersClient currentUserId={ADMIN} canManage />);
    expect(await screen.findByRole("columnheader", { name: "SDR" })).toBeInTheDocument();

    const doAgente = await screen.findByRole("switch", { name: "SDR: Agente" });
    await waitFor(() => expect(doAgente).not.toBeDisabled());
    await userEvent.click(doAgente);
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/sdr/assignments", { user_id: AGENTE });

    const doAdmin = screen.getByRole("switch", { name: "SDR: Admin" });
    await waitFor(() => expect(doAdmin).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(doAdmin).not.toBeDisabled());
    await userEvent.click(doAdmin);
    expect(apiClient.delete).toHaveBeenCalledWith(`/api/v1/sdr/assignments/${ADMIN}`);
  });

  it("papel Somente leitura não pode ser marcado; o rebaixado mostra por que a marca não vale e pode ser desmarcado", async () => {
    ligado = true;
    atribuidos = [
      {
        user_id: REBAIXADO,
        full_name: "Rebaixado",
        role: "viewer",
        assigned_since: "2026-11-01T00:00:00Z",
        active: false,
        inactive_reason: "role_below_minimum",
      },
    ];
    renderizar(<TeamMembersClient currentUserId={ADMIN} canManage />);

    const doViewer = await screen.findByRole("switch", { name: "SDR: Visual" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "SDR: Agente" })).not.toBeDisabled());
    expect(doViewer).toBeDisabled();

    expect(await screen.findByText("Sem efeito: o papel Somente leitura não pode ser SDR.")).toBeInTheDocument();
    const doRebaixado = screen.getByRole("switch", { name: "SDR: Rebaixado" });
    expect(doRebaixado).toHaveAttribute("aria-checked", "true");
    expect(doRebaixado).not.toBeDisabled();
  });

  it("gerente vê quem é SDR, sem interruptores", async () => {
    ligado = true;
    atribuidos = [
      { user_id: AGENTE, full_name: "Agente", role: "agent", assigned_since: "2026-11-01T00:00:00Z", active: true, inactive_reason: null },
    ];
    renderizar(<TeamMembersClient currentUserId={ADMIN} canManage={false} />);
    expect(await screen.findByRole("columnheader", { name: "SDR" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("SDR").length).toBeGreaterThan(1));
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
