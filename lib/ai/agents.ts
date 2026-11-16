/**
 * Busca o ai_agent configurado como agente de VOZ pra uma org
 * (ai_agents.channel = 'voice', coluna aditiva da migration 0347).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_CONFIG_DEFAULTS, agentConfigSchema } from "@/lib/ai/guardrails-schema";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

export interface VoiceAgentConfig {
  id: string;
  systemPrompt: string;
  /** Voz e velocidade da fala (session.audio.output) e parâmetros de RAG —
   *  configuráveis por Configurações > Agente > aba Voz, com fallback pros
   *  defaults quando a organização nunca mexeu nisso. */
  voice: string;
  voiceSpeed: number;
  ragTopK: number;
  ragSimilarityThreshold: number;
  voiceModel: string;
  /**
   * Chave da OpenAI pra abrir a sessão Realtime (WebSocket cru, não passa
   * pelo AI Gateway). Vem, em ordem: credencial cadastrada em IA >
   * Credenciais pra esta org, ou env OPENAI_API_KEY do servidor.
   */
  apiKey: string;
}

/**
 * A chave OpenAI ativa e validada desta org, cadastrada em IA > Credenciais --
 * mesma tabela/decrypt que o resto do produto usa (ver lib/ai/embeddings/chave.ts,
 * que resolve o mesmo tipo de chave pra embeddings). Sem credencial de org, cai
 * na chave do .env do servidor -- nunca deixa a ligação sem chave nenhuma.
 *
 * Desempate determinístico pela mais antiga (não "a mais recente"): com duas
 * chaves cadastradas e nenhuma escolha explícita, variar sozinho no dia em que
 * alguém cadastra uma segunda é pior que sempre usar a mesma.
 */
async function resolverChaveOpenAiDaVoz(organizationId: string): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openai")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (data) {
      return decryptKey({
        ciphertext: byteaToBuffer(data.api_key_encrypted),
        iv: byteaToBuffer(data.api_key_iv),
        tag: byteaToBuffer(data.api_key_tag),
      });
    }
  } catch {
    // Decrypt falhou ou a query deu erro -- cai pro .env abaixo, log já
    // aconteceu no INFO deste arquivo se aplicável; não vale a pena arriscar
    // ecoar detalhe de credencial no log do worker.
  }
  return process.env.OPENAI_API_KEY ?? "";
}

/**
 * O agente de voz que atende uma ligação.
 *
 * `agenteEscolhidoId` é o agente que o NÚMERO discado aponta
 * (`phone_numbers.default_ai_agent_id`, gravado em `voice_calls.ai_agent_id`).
 * Ele vence quando ainda é um agente de voz ativo DESTA organização; senão
 * (apagado, desativado, de outro canal) vale o primeiro agente de voz ativo,
 * como antes de o número poder escolher. Sem isto a escolha feita na tela de
 * Telefonia era ignorada: toda ligação caía no primeiro agente que o banco
 * devolvesse.
 */
export async function getActiveVoiceAgent(
  organizationId: string,
  agenteEscolhidoId?: string | null,
): Promise<VoiceAgentConfig | null> {
  const supabase = createAdminClient();
  const base = () =>
    supabase
      .from("ai_agents")
      .select("id, system_prompt, config")
      .eq("organization_id", organizationId)
      .eq("channel", "voice")
      .eq("is_active", true);

  let data: { id: string; system_prompt: string; config: unknown } | null = null;
  if (agenteEscolhidoId) {
    const escolhido = await base().eq("id", agenteEscolhidoId).maybeSingle();
    if (!escolhido.error) data = escolhido.data;
  }
  if (!data) {
    const primeiro = await base().limit(1).maybeSingle();
    if (primeiro.error) return null;
    data = primeiro.data;
  }
  if (!data) return null;

  const cfgParsed = agentConfigSchema.safeParse({
    ...AGENT_CONFIG_DEFAULTS,
    ...((data.config ?? {}) as Record<string, unknown>),
  });
  const cfg = cfgParsed.success ? cfgParsed.data : AGENT_CONFIG_DEFAULTS;

  return {
    id: data.id,
    systemPrompt: data.system_prompt,
    voice: cfg.voice,
    voiceSpeed: cfg.voice_speed,
    voiceModel: cfg.voice_model,
    ragTopK: cfg.rag_top_k,
    ragSimilarityThreshold: cfg.rag_similarity_threshold,
    apiKey: await resolverChaveOpenAiDaVoz(organizationId),
  };
}
