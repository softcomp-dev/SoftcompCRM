/**
 * Semente do módulo "Trunk SIP": a tela começa como numa instalação fresca,
 * sem provedor cadastrado. As lições cadastram um pela própria tela (o Salvar
 * real, que cifra a senha); aqui só apagamos a linha que uma rodada anterior
 * deixou. Uma linha por organização (organization_id é a chave primária).
 *
 * Apaga também `voip_trunk_status`, o que o worker de voz fez com o tronco: uma
 * linha esquecida de outra rodada faria o quadro "No servidor" mostrar um
 * resultado de uma configuração que não existe mais. A bancada não tem worker
 * de voz, então depois do Salvar o quadro fica em "Aguardando o servidor
 * aplicar" — que é o que a lição mostra, e os outros resultados ela explica em
 * texto.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  semErro(await c.db.from("voip_trunk_status").delete().eq("organization_id", c.org), "limpar estado do tronco SIP");
  semErro(await c.db.from("voip_trunk_settings").delete().eq("organization_id", c.org), "limpar trunk SIP");
}
