// SESSÃO DE VOZ FALSA — o lado OpenAI Realtime do teste de ligação do CI.
//
//   node docker/teste-de-ligacao/sessao-de-voz-falsa.mjs [porta]
//
// Fala o pedaço do protocolo que a ponte (workers/voice-agent/audioSocketBridge.ts)
// usa: recebe `session.update` e `response.create`; responde com áudio (silêncio
// em µ-law), a transcrição da fala, `response.done` com uso e a chamada da
// função `encerrar_chamada` — e a ponte desliga a ligação. Nenhum byte sai para
// a OpenAI, nenhum minuto é pago.
//
// Grava em `sessoes.jsonl` (ao lado do processo) o que recebeu, para o passo de
// conferência provar que a sessão abriu com as instruções do agente.
import { appendFileSync } from "node:fs";

import { WebSocketServer } from "ws";

const porta = Number(process.argv[2] ?? 8099);
const servidor = new WebSocketServer({ port: porta });

const FALA = "Olá, aqui é o atendimento de teste. Até logo!";
// 100 ms de silêncio µ-law (0xFF) a 8 kHz.
const SILENCIO = Buffer.alloc(800, 0xff).toString("base64");

servidor.on("connection", (ws, req) => {
  const registro = { url: req.url, instrucoes: null, ferramentas: [], respostas: 0 };
  const salvar = () => appendFileSync("sessoes.jsonl", JSON.stringify(registro) + "\n");

  ws.on("message", (raw) => {
    const evento = JSON.parse(raw.toString());
    if (evento.type === "session.update") {
      registro.instrucoes = evento.session?.instructions ?? null;
      registro.ferramentas = (evento.session?.tools ?? []).map((t) => t.name);
      return;
    }
    if (evento.type !== "response.create") return;

    registro.respostas += 1;
    const enviar = (e) => ws.send(JSON.stringify(e));
    enviar({ type: "response.created" });
    for (let i = 0; i < 5; i++) enviar({ type: "response.output_audio.delta", delta: SILENCIO });
    enviar({ type: "response.output_audio_transcript.done", transcript: FALA });
    enviar({
      type: "response.done",
      response: {
        output: [{ type: "function_call", name: "encerrar_chamada" }],
        usage: {
          input_tokens: 120,
          output_tokens: 60,
          input_token_details: { text_tokens: 100, audio_tokens: 20, cached_tokens: 0 },
          output_token_details: { text_tokens: 15, audio_tokens: 45 },
        },
      },
    });
    salvar();
  });
});

console.log(`[sessão falsa] escutando em ws://127.0.0.1:${porta}`);
