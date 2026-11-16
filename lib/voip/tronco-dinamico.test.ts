import { describe, expect, it } from "vitest";

import { hashDoTronco, objetosDoTronco, organizacaoDoEndpoint, type TroncoSalvo } from "./tronco-dinamico";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T: TroncoSalvo = {
  organization_id: ORG,
  host: "sip.operadora.example",
  port: 5060,
  username: "1234",
  from_domain: null,
  endpoint_name: `org-${ORG}-trunk-endpoint`,
  is_active: true,
  password_encrypted: "\\x0102",
  password_iv: "\\x0304",
};

describe("tronco como objetos do PJSIP", () => {
  it("cinco objetos, na ordem de criação, com os ids do bloco que a tela sempre gerou", () => {
    const ids = objetosDoTronco(T, "s3nha").map((o) => `${o.objectType}:${o.id}`);
    const ep = T.endpoint_name;
    expect(ids).toEqual([
      `auth:${ep}-auth`,
      `aor:${ep}-aor`,
      `endpoint:${ep}`,
      `identify:${ep}-identify`,
      `registration:${ep}-registration`,
    ]);
  });

  it("o endpoint recebe as ligações em from-trunk e aponta para o auth e o aor", () => {
    const endpoint = objetosDoTronco(T, "x").find((o) => o.objectType === "endpoint")!;
    const campo = (a: string) => endpoint.fields.find((f) => f.attribute === a)?.value;
    expect(campo("context")).toBe("from-trunk");
    expect(campo("outbound_auth")).toBe(`${T.endpoint_name}-auth`);
    expect(campo("aors")).toBe(`${T.endpoint_name}-aor`);
    // Sem from_domain na tela, vale o host — nunca o IP privado do contêiner.
    expect(campo("from_domain")).toBe("sip.operadora.example");
  });

  it("a senha vai só no auth", () => {
    const comSenha = objetosDoTronco(T, "s3nha").filter((o) => o.fields.some((f) => f.value === "s3nha"));
    expect(comSenha.map((o) => o.objectType)).toEqual(["auth"]);
  });

  it("o hash muda com a senha (forma cifrada) e com o host, e não depende da ordem das chaves", () => {
    const h = hashDoTronco(T);
    expect(hashDoTronco({ ...T })).toBe(h);
    expect(hashDoTronco({ ...T, password_encrypted: "\\x0999" })).not.toBe(h);
    expect(hashDoTronco({ ...T, host: "outro.example" })).not.toBe(h);
    expect(hashDoTronco({ ...T, is_active: false })).not.toBe(h);
  });

  it("acha a organização pelo nome do endpoint", () => {
    expect(organizacaoDoEndpoint(T.endpoint_name)).toBe(ORG);
    expect(organizacaoDoEndpoint("trunk-endpoint")).toBeNull();
    expect(organizacaoDoEndpoint(undefined)).toBeNull();
  });
});
