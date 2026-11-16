/**
 * O TRONCO SIP DE UMA ORGANIZAÇÃO, COMO OBJETOS DO PJSIP — puro, sem rede.
 *
 * Salvar o tronco na tela (Configurações › Trunk SIP, `voip_trunk_settings`)
 * não mudava nada no servidor: o operador colava o bloco gerado no
 * `asterisk/pjsip.conf` e reiniciava. Agora o worker de voz empurra estes
 * objetos pela ARI (configuração dinâmica, `PUT /asterisk/config/dynamic/...`),
 * que o Asterisk persiste no astdb (`asterisk/sorcery.conf`).
 *
 * Os ids batem com o bloco que a tela sempre gerou (`<endpoint>-auth`,
 * `<endpoint>-aor`, `<endpoint>-registration`), então uma instalação que já
 * colou o bloco à mão não ganha um segundo tronco com outro nome.
 *
 * O transporte (`transport-udp`, com o IP público em
 * `external_media_address`) continua no `pjsip.conf`: ele é do SERVIDOR, não
 * da organização, e o instalador o escreve.
 */
import { createHash } from "node:crypto";

export interface TroncoSalvo {
  organization_id: string;
  host: string;
  port: number;
  username: string;
  from_domain: string | null;
  endpoint_name: string;
  is_active: boolean;
  /** A senha CIFRADA, como vem do banco — entra no hash, nunca em claro. */
  password_encrypted: string;
  password_iv: string;
}

export interface ObjetoPjsip {
  configClass: string;
  objectType: string;
  id: string;
  fields: Array<{ attribute: string; value: string }>;
}

/**
 * Hash da configuração: muda quando qualquer coisa que vai ao Asterisk muda,
 * inclusive a senha (pela forma cifrada e pelo IV, que é novo a cada cifragem).
 */
export function hashDoTronco(t: TroncoSalvo): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        t.host,
        t.port,
        t.username,
        t.from_domain ?? "",
        t.endpoint_name,
        t.is_active,
        t.password_encrypted,
        t.password_iv,
      ]),
    )
    .digest("hex");
}

function campos(o: Record<string, string>): Array<{ attribute: string; value: string }> {
  return Object.entries(o).map(([attribute, value]) => ({ attribute, value }));
}

/**
 * Os cinco objetos do tronco, NA ORDEM de criação (quem referencia vem
 * depois do referenciado). Para remover, use a ordem inversa.
 */
export function objetosDoTronco(t: TroncoSalvo, senha: string): ObjetoPjsip[] {
  const ep = t.endpoint_name;
  const servidor = `sip:${t.host}:${t.port}`;
  const dominio = t.from_domain?.trim() || t.host;
  return [
    {
      configClass: "res_pjsip",
      objectType: "auth",
      id: `${ep}-auth`,
      fields: campos({ auth_type: "userpass", username: t.username, password: senha }),
    },
    {
      configClass: "res_pjsip",
      objectType: "aor",
      id: `${ep}-aor`,
      fields: campos({ contact: servidor, qualify_frequency: "30" }),
    },
    {
      configClass: "res_pjsip",
      objectType: "endpoint",
      id: ep,
      fields: campos({
        transport: "transport-udp",
        // Para onde vai a ligação RECEBIDA (extensions.conf, [from-trunk]).
        context: "from-trunk",
        disallow: "all",
        // ulaw casa com o formato do AudioSocket (evita transcodificação).
        allow: "ulaw,alaw",
        outbound_auth: `${ep}-auth`,
        aors: `${ep}-aor`,
        from_user: t.username,
        // Sem from_domain o header From vaza o IP privado do contêiner —
        // alguns provedores derrubam a ligação ~1 s depois do 183.
        from_domain: dominio,
        direct_media: "no",
        rtp_symmetric: "yes",
        force_rport: "yes",
        rewrite_contact: "yes",
      }),
    },
    {
      configClass: "res_pjsip_endpoint_identifier_ip",
      objectType: "identify",
      id: `${ep}-identify`,
      fields: campos({ endpoint: ep, match: t.host }),
    },
    {
      configClass: "res_pjsip_outbound_registration",
      objectType: "registration",
      id: `${ep}-registration`,
      fields: campos({
        transport: "transport-udp",
        outbound_auth: `${ep}-auth`,
        server_uri: servidor,
        client_uri: `sip:${t.username}@${t.host}:${t.port}`,
        contact_user: t.username,
        retry_interval: "60",
      }),
    },
  ];
}

/** O id da organização a partir do nome do endpoint (`org-<uuid>-trunk-endpoint`), ou null. */
export function organizacaoDoEndpoint(endpoint: string | null | undefined): string | null {
  const m = /^org-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-trunk-endpoint$/i.exec(
    (endpoint ?? "").trim(),
  );
  return m ? m[1]!.toLowerCase() : null;
}
