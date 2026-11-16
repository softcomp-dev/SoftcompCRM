import { describe, expect, it } from "vitest";

import {
  agruparChats,
  daChamada,
  doRegistro,
  montarPagina,
  type AtividadeBruta,
  type ChamadaBruta,
  type MensagemBruta,
} from "./historico";

const FUSO = "America/Sao_Paulo"; // UTC-3, sem horário de verão

let seq = 0;
function msg(sent_at: string, extra: Partial<MensagemBruta> = {}): MensagemBruta {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "conv-1",
    direction: "inbound",
    sent_via: "crm",
    sent_by_user_id: null,
    type: "text",
    status: "received",
    sent_at,
    ...extra,
  };
}

function chamada(extra: Partial<ChamadaBruta> = {}): ChamadaBruta {
  return {
    id: "call-1",
    provider: "sip",
    direction: "outbound",
    status: "ended",
    started_at: "2026-11-10T13:00:00.000Z",
    answered_at: "2026-11-10T13:00:10.000Z",
    ended_at: "2026-11-10T13:05:10.000Z",
    duration_ms: null,
    owner_user_id: "user-a",
    created_by: null,
    handled_by: "human",
    lead_id: "lead-1",
    ...extra,
  };
}

function registro(extra: Partial<AtividadeBruta> = {}): AtividadeBruta {
  return {
    id: "act-1",
    type: "interaction_logged",
    lead_id: "lead-1",
    performed_at: "2026-11-09T15:00:00.000Z",
    performed_by_user_id: "user-b",
    reason: "Visitou a loja e pediu orçamento",
    payload: { channel: "visit", direction: "inbound", outcome: "talked", duration_minutes: 30 },
    ...extra,
  };
}

const vazio = { linhas: [], noTeto: false };

describe("agruparChats", () => {
  it("junta as mensagens da mesma conversa no mesmo dia local, e conta de quem é cada fala", () => {
    const itens = agruparChats(
      [
        msg("2026-11-10T12:00:00.000Z"), // 09:00 local, cliente começa
        msg("2026-11-10T12:01:00.000Z", { direction: "outbound", sent_via: "ai" }),
        msg("2026-11-10T12:05:00.000Z", { direction: "outbound", sent_via: "crm", sent_by_user_id: "user-a" }),
        msg("2026-11-10T12:06:00.000Z", { direction: "outbound", sent_via: "external_device", sent_by_user_id: "user-a" }),
        msg("2026-11-10T12:07:00.000Z", { direction: "outbound", sent_via: "automation" }),
      ],
      FUSO,
    );
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({
      source: "chat",
      channel: "whatsapp_chat",
      direction: "inbound",
      started_at: "2026-11-10T12:00:00.000Z",
      ended_at: "2026-11-10T12:07:00.000Z",
      handled_by_ai: true,
      team_user_ids: ["user-a"],
      messages: { from_contact: 1, from_team: 2, from_ai: 1, automated: 1 },
    });
  });

  it("separa por dia no fuso da organização, não em UTC", () => {
    // 01:30 UTC do dia 11 ainda é 22:30 do dia 10 em São Paulo.
    const itens = agruparChats(
      [msg("2026-11-10T20:00:00.000Z"), msg("2026-11-11T01:30:00.000Z"), msg("2026-11-11T12:00:00.000Z")],
      FUSO,
    );
    expect(itens.map((i) => i.id).sort()).toEqual(["chat:conv-1:2026-11-10", "chat:conv-1:2026-11-11"]);
    const dia10 = itens.find((i) => i.id.endsWith("2026-11-10"))!;
    expect(dia10.messages?.from_contact).toBe(2);
  });

  it("não conta reação, aviso do sistema nem envio que falhou", () => {
    const itens = agruparChats(
      [
        msg("2026-11-10T12:00:00.000Z", { type: "reaction" }),
        msg("2026-11-10T12:01:00.000Z", { type: "system" }),
        msg("2026-11-10T12:02:00.000Z", { direction: "outbound", status: "failed" }),
      ],
      FUSO,
    );
    expect(itens).toEqual([]);
  });
});

describe("daChamada", () => {
  it("VoIP atendida é conversa, com a duração calculada quando a do banco falta", () => {
    expect(daChamada(chamada())).toMatchObject({
      id: "call:call-1",
      channel: "voip",
      outcome: "talked",
      duration_seconds: 300,
      team_user_ids: ["user-a"],
      handled_by_ai: false,
    });
  });

  it("ligação pelo WhatsApp encerrada sem atender é tentativa; a que ainda toca não tem desfecho", () => {
    expect(daChamada(chamada({ provider: "wacalls", answered_at: null, duration_ms: 0 }))).toMatchObject({
      channel: "whatsapp_call",
      outcome: "no_answer",
    });
    expect(daChamada(chamada({ status: "ringing", answered_at: null, ended_at: null })).outcome).toBeNull();
  });

  it("atendida pela IA fica marcada", () => {
    expect(daChamada(chamada({ handled_by: "ai" })).handled_by_ai).toBe(true);
  });
});

describe("doRegistro", () => {
  it("o registro manual traz canal, direção, desfecho, duração e o texto de quem registrou", () => {
    expect(doRegistro(registro())).toMatchObject({
      id: "record:act-1",
      source: "record",
      channel: "visit",
      direction: "inbound",
      outcome: "talked",
      duration_seconds: 1800,
      summary: "Visitou a loja e pediu orçamento",
      team_user_ids: ["user-b"],
      lead_id: "lead-1",
    });
  });

  it("o resultado do cold call entra como ligação de saída do vendedor", () => {
    expect(doRegistro(registro({ type: "cold_call_result", payload: { resultado: "sem_interesse" } }))).toMatchObject({
      channel: "phone",
      direction: "outbound",
      outcome: null,
    });
  });

  it("payload estragado degrada pelo tipo, e atividade que não é interação fica de fora", () => {
    expect(doRegistro(registro({ type: "interaction_attempted", payload: null }))).toMatchObject({
      channel: "other",
      outcome: "no_answer",
      direction: null,
    });
    expect(doRegistro(registro({ type: "note" }))).toBeNull();
    expect(doRegistro(registro({ type: "voice_call" }))).toBeNull();
  });
});

describe("montarPagina", () => {
  it("sem fonte no teto e cabendo no limite, entrega tudo, mais recente primeiro, e acaba", () => {
    const pagina = montarPagina({
      fuso: FUSO,
      limite: 10,
      mensagens: { linhas: [msg("2026-11-11T12:00:00.000Z")], noTeto: false },
      chamadas: { linhas: [chamada()], noTeto: false },
      registros: { linhas: [registro()], noTeto: false },
    });
    expect(pagina.itens.map((i) => i.source)).toEqual(["chat", "call", "record"]);
    expect(pagina.proximoAntes).toBeNull();
  });

  it("quando o limite corta um dia, o dia inteiro fica para a próxima página", () => {
    const pagina = montarPagina({
      fuso: FUSO,
      limite: 2,
      mensagens: vazio,
      chamadas: {
        linhas: [
          chamada({ id: "c3", started_at: "2026-11-12T13:00:00.000Z" }),
          chamada({ id: "c2", started_at: "2026-11-10T15:00:00.000Z" }),
          chamada({ id: "c1", started_at: "2026-11-10T13:00:00.000Z" }),
        ],
        noTeto: false,
      },
      registros: vazio,
    });
    // c2 coube no limite, mas c1 é do mesmo dia e não coube: o dia 10 vai junto.
    expect(pagina.itens.map((i) => i.id)).toEqual(["call:c3"]);
    // Fim do dia 10 em São Paulo = 03:00 UTC do dia 11.
    expect(pagina.proximoAntes).toBe("2026-11-11T03:00:00.000Z");
  });

  it("fonte que bateu no teto torna suspeito o dia da linha mais antiga dela", () => {
    const pagina = montarPagina({
      fuso: FUSO,
      limite: 50,
      mensagens: {
        linhas: [msg("2026-11-12T12:00:00.000Z"), msg("2026-11-10T12:00:00.000Z")],
        noTeto: true,
      },
      chamadas: { linhas: [chamada({ started_at: "2026-11-09T12:00:00.000Z" })], noTeto: false },
      registros: vazio,
    });
    // O chat do dia 10 pode ter mais mensagens antes; a ligação do dia 9 é mais
    // antiga que o corte e também espera — senão o cursor pularia o dia 10.
    expect(pagina.itens.map((i) => i.id)).toEqual(["chat:conv-1:2026-11-12"]);
    expect(pagina.proximoAntes).toBe("2026-11-11T03:00:00.000Z");
  });

  it("página que é um dia só entrega o dia e anda para trás, nunca o mesmo cursor de novo", () => {
    const pagina = montarPagina({
      fuso: FUSO,
      limite: 1,
      mensagens: vazio,
      chamadas: {
        linhas: [
          chamada({ id: "c2", started_at: "2026-11-10T15:00:00.000Z" }),
          chamada({ id: "c1", started_at: "2026-11-10T13:00:00.000Z" }),
        ],
        noTeto: true,
      },
      registros: vazio,
    });
    expect(pagina.itens.map((i) => i.id)).toEqual(["call:c2", "call:c1"]);
    // Início do dia 10 em São Paulo = 03:00 UTC do dia 10.
    expect(pagina.proximoAntes).toBe("2026-11-10T03:00:00.000Z");
  });
});
