import { describe, expect, it } from "vitest";

import { discagemPjsip } from "./discagem";

describe("discagemPjsip", () => {
  it("tronco do env (PJSIP/nome)", () => {
    expect(discagemPjsip("PJSIP/trunk-endpoint", "+5527999990000")).toBe("PJSIP/5527999990000@trunk-endpoint");
  });

  it("tronco salvo pela tela (só o nome da seção) ganha o PJSIP", () => {
    const nome = "org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-trunk-endpoint";
    expect(discagemPjsip(nome, "5527999990000")).toBe(`PJSIP/5527999990000@${nome}`);
  });
});
