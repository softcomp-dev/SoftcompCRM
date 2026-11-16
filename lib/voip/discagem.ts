/**
 * A string de discagem PJSIP de um número por um tronco.
 *
 * O tronco chega de duas fontes, em dois formatos:
 *   - `VOIP_TRUNK_ENDPOINT` (env, o legado): `PJSIP/trunk-endpoint`;
 *   - `voip_trunk_settings.endpoint_name` (a tela, migration 0349):
 *     `org-<uuid>-trunk-endpoint`, só o nome da seção do `pjsip.conf`.
 *
 * O `originateCall` fazia `split("/")` e supunha o primeiro formato: com o
 * tronco salvo pela tela, `tech` virava o nome inteiro e o endpoint,
 * `undefined` — a discagem saía `org-…/5527…@undefined`, e toda ligação feita
 * de uma organização que cadastrou o tronco pela tela falhava no Asterisk.
 *
 * PJSIP/<destino>@<endpoint> é o formato que funciona (testado ao vivo, ver
 * `ariClient.ts`); o `+` sai porque PJSIP o recusa na URI.
 */
export function discagemPjsip(trunkEndpoint: string, numero: string): string {
  const destino = numero.trim().replace(/^\+/, "");
  const cru = trunkEndpoint.trim();
  const barra = cru.indexOf("/");
  const tech = barra >= 0 ? cru.slice(0, barra) : "PJSIP";
  const endpoint = barra >= 0 ? cru.slice(barra + 1) : cru;
  return `${tech}/${destino}@${endpoint}`;
}
